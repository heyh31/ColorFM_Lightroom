//! Reference harness for differential testing the TypeScript port.
//!
//! Every subcommand reads a JSON request and prints a JSON response with the
//! **raw f32 bit patterns** of the values it computed, so the TypeScript side
//! can be compared bit for bit instead of within a tolerance.
//!
//! Only used by the test suite; nothing in `packages/` depends on it.

use std::path::Path;
use std::sync::atomic::AtomicBool;

use serde_json::{json, Value};

use colorfm_core::infer::{ParamPredictor, Thumb, INPUT_SIZE};
use colorfm_core::lut::cube;
use colorfm_core::params::Params;
use colorfm_core::{infer, io, lut, mlp, pipeline};

fn main() {
    let mut args = std::env::args().skip(1);
    let command = match args.next() {
        Some(command) => command,
        None => fail("usage: colorfm-reference <command> <request.json>"),
    };
    let request = match args.next() {
        Some(path) => {
            let text = std::fs::read_to_string(&path)
                .unwrap_or_else(|err| fail(&format!("cannot read {path}: {err}")));
            serde_json::from_str::<Value>(&text)
                .unwrap_or_else(|err| fail(&format!("bad JSON in {path}: {err}")))
        }
        None => fail("missing request file"),
    };

    let response = match command.as_str() {
        "f32ops" => f32ops(&request),
        "params" => params(&request),
        "mlp" => mlp_cmd(&request),
        "bake" => bake(&request),
        "apply" => apply(&request),
        "bench" => bench(&request),
        "blend" => blend(&request),
        "cube_write" => cube_write(&request),
        "cube_read" => cube_read(&request),
        "thumb" => thumb(&request),
        "preview" => preview(&request),
        "transform" => transform(&request),
        "jpeg" => jpeg(&request),
        "fixture" => fixture(&request),
        "png16" => png16(&request),
        "raw_pixels" => raw_pixels(&request),
        "predict" => predict(&request),
        other => fail(&format!("unknown command: {other}")),
    };

    println!("{}", serde_json::to_string(&response).unwrap());
}

fn fail(message: &str) -> ! {
    eprintln!("{message}");
    std::process::exit(2);
}

// --- helpers ---------------------------------------------------------------

fn bits(values: &[f32]) -> Vec<String> {
    values.iter().map(|v| format!("{:08x}", v.to_bits())).collect()
}

fn flat(values: &[[f32; 3]]) -> Vec<f32> {
    let mut out = Vec::with_capacity(values.len() * 3);
    for px in values {
        out.extend_from_slice(px);
    }
    out
}

fn f32s(value: &Value, key: &str) -> Vec<f32> {
    value[key]
        .as_array()
        .unwrap_or_else(|| fail(&format!("missing array: {key}")))
        .iter()
        .map(|v| v.as_f64().unwrap_or_else(|| fail("not a number")) as f32)
        .collect()
}

fn samples(value: &Value) -> Vec<[f32; 3]> {
    value["samples"]
        .as_array()
        .unwrap_or_else(|| fail("missing samples"))
        .iter()
        .map(|px| {
            let px = px.as_array().unwrap_or_else(|| fail("sample is not an array"));
            [
                px[0].as_f64().unwrap() as f32,
                px[1].as_f64().unwrap() as f32,
                px[2].as_f64().unwrap() as f32,
            ]
        })
        .collect()
}

fn params_of(value: &Value) -> Params {
    Params::from_slice(&f32s(value, "params")).unwrap_or_else(|err| fail(&err.to_string()))
}

fn string(value: &Value, key: &str) -> String {
    value[key]
        .as_str()
        .unwrap_or_else(|| fail(&format!("missing string: {key}")))
        .to_string()
}

fn u32_of(value: &Value, key: &str) -> u32 {
    value[key]
        .as_u64()
        .unwrap_or_else(|| fail(&format!("missing number: {key}"))) as u32
}

fn f32_of(value: &Value, key: &str) -> f32 {
    value[key]
        .as_f64()
        .unwrap_or_else(|| fail(&format!("missing number: {key}"))) as f32
}

// --- commands --------------------------------------------------------------

/// `swish`/`exp` on a list of inputs, to check that JS `Math.exp` rounded to
/// f32 matches Rust's `f32::exp`.
fn f32ops(request: &Value) -> Value {
    let values = f32s(request, "values");
    let swish: Vec<f32> = values.iter().map(|x| x / (1.0 + (-*x).exp())).collect();
    let exp: Vec<f32> = values.iter().map(|x| x.exp()).collect();
    json!({ "swish": bits(&swish), "exp": bits(&exp) })
}

fn params(request: &Value) -> Value {
    let values = f32s(request, "values");
    match Params::from_slice(&values) {
        Ok(params) => {
            let mut k1 = Vec::new();
            for row in &params.content.k1 {
                k1.extend_from_slice(row);
            }
            let mut k4 = Vec::new();
            for row in &params.style.k4 {
                k4.extend_from_slice(row);
            }
            json!({
                "ok": true,
                "values": bits(&params.to_vec()),
                "k1": bits(&k1),
                "k4": bits(&k4),
            })
        }
        Err(err) => json!({ "ok": false, "error": err.to_string() }),
    }
}

fn mlp_cmd(request: &Value) -> Value {
    let params = params_of(request);
    let samples = samples(request);
    let single: Vec<f32> = samples
        .iter()
        .flat_map(|px| mlp::transfer(&params, *px).to_vec())
        .collect();
    let batch = flat(&mlp::transfer_batch(&params, &samples));
    json!({ "single": bits(&single), "batch": bits(&batch) })
}

fn bake(request: &Value) -> Value {
    let params = params_of(request);
    let size = u32_of(request, "size") as u8;
    let table = lut::bake(&params, size);
    let threads = request["threads"].as_u64().unwrap_or(2) as usize;
    let parallel = lut::bake_parallel(&params, size, threads);
    json!({
        "size": table.size(),
        "bits": bits(&flat(table.data())),
        "parallel_bits": bits(&flat(parallel.data())),
    })
}

/// Timings for the two operations the engine spends its time in.
///
/// The values are the minimum over `iterations`, which is the closest thing to
/// a quiet measurement on a machine that is also running a desktop window.
/// `black_box` keeps the optimiser from hoisting the work out of the loop.
fn bench(request: &Value) -> Value {
    use std::hint::black_box;
    use std::time::Instant;

    let params = params_of(request);
    let size = u32_of(request, "size") as u8;
    let iterations = request["iterations"].as_u64().unwrap_or(5).max(1) as usize;
    let threads = request["threads"]
        .as_u64()
        .map(|value| value as usize)
        .unwrap_or_else(lut::default_threads);
    let pixels = request["pixels"].as_u64().unwrap_or(8_000_000) as usize;

    // The first bake pays for page faults and cache misses; time it separately.
    black_box(lut::bake(&params, size));

    let mut bake_ms = f64::MAX;
    for _ in 0..iterations {
        let started = Instant::now();
        let table = lut::bake(&params, size);
        bake_ms = bake_ms.min(started.elapsed().as_secs_f64() * 1000.0);
        black_box(&table);
    }

    let mut parallel_ms = f64::MAX;
    for _ in 0..iterations {
        let started = Instant::now();
        let table = lut::bake_parallel(&params, size, threads);
        parallel_ms = parallel_ms.min(started.elapsed().as_secs_f64() * 1000.0);
        black_box(&table);
    }

    let table = lut::bake(&params, size);
    let mut buffer: Vec<[f32; 3]> = (0..pixels)
        .map(|index| {
            let v = (index % 65536) as f32 / 65535.0;
            [v, 1.0 - v * 0.5, v * 0.25]
        })
        .collect();

    let mut apply_ms = f64::MAX;
    for _ in 0..iterations {
        let started = Instant::now();
        lut::apply_in_place(&table, &mut buffer);
        apply_ms = apply_ms.min(started.elapsed().as_secs_f64() * 1000.0);
    }

    json!({
        "size": table.size(),
        "threads": threads,
        "iterations": iterations,
        "pixels": pixels,
        "bake_ms": bake_ms,
        "bake_parallel_ms": parallel_ms,
        "apply_ms": apply_ms,
        "mpx_per_s": pixels as f64 / (apply_ms / 1000.0) / 1e6,
    })
}

fn apply(request: &Value) -> Value {
    let params = params_of(request);
    let size = u32_of(request, "size") as u8;
    let table = lut::bake(&params, size);
    let input = samples(request);
    let strength = f32_of(request, "strength");

    let single = flat(
        &input
            .iter()
            .map(|px| lut::apply(&table, *px))
            .collect::<Vec<_>>(),
    );
    let batch = flat(&lut::apply_batch(&table, &input));

    let mut in_place = input.clone();
    lut::apply_in_place(&table, &mut in_place);

    let mut with_strength = input.clone();
    lut::apply_in_place_strength(&table, &mut with_strength, strength);

    let parallel = flat(&lut::apply_parallel(&table, &input, 3));

    json!({
        "apply": bits(&single),
        "batch": bits(&batch),
        "in_place": bits(&flat(&in_place)),
        "strength": bits(&flat(&with_strength)),
        "parallel": bits(&parallel),
    })
}

fn blend(request: &Value) -> Value {
    let params = params_of(request);
    let size = u32_of(request, "size") as u8;
    let t = f32_of(request, "t");
    let table = lut::bake(&params, size);
    let identity = lut::Lut3D::identity(size);
    let clamped = lut::blend(&identity, &table, t);
    let extrapolated = lut::blend_extrapolate(&identity, &table, t);
    json!({
        "clamped": bits(&flat(clamped.data())),
        "extrapolated": bits(&flat(extrapolated.data())),
    })
}

fn cube_write(request: &Value) -> Value {
    let params = params_of(request);
    let size = u32_of(request, "size") as u8;
    let title = request["title"].as_str().unwrap_or("ColorFM");
    let table = lut::bake(&params, size);
    let mut buffer = Vec::new();
    cube::write(&table, &mut buffer, title).unwrap();
    json!({ "text": String::from_utf8(buffer).unwrap() })
}

fn cube_read(request: &Value) -> Value {
    let text = string(request, "text");
    match cube::read(std::io::Cursor::new(text)) {
        Ok(table) => json!({ "ok": true, "size": table.size(), "bits": bits(&flat(table.data())) }),
        Err(err) => json!({ "ok": false, "error": err.to_string() }),
    }
}

fn thumb(request: &Value) -> Value {
    let src = string(request, "src");
    let side = u32_of(request, "side");
    match io::thumb::thumbnail_any(Path::new(&src), side) {
        Ok(thumb) => json!({
            "ok": true,
            "width": thumb.width,
            "height": thumb.height,
            "bits": bits(&flat(&thumb.pixels)),
        }),
        Err(err) => json!({ "ok": false, "error": err.to_string() }),
    }
}

fn preview(request: &Value) -> Value {
    let src = string(request, "src");
    let max_edge = u32_of(request, "max_edge");
    match io::preview(Path::new(&src), max_edge) {
        Ok((width, height, pixels)) => json!({
            "ok": true,
            "width": width,
            "height": height,
            "bits": bits(&flat(&pixels)),
        }),
        Err(err) => json!({ "ok": false, "error": err.to_string() }),
    }
}

fn transform(request: &Value) -> Value {
    let src = string(request, "src");
    let dst = string(request, "dst");
    let params = params_of(request);
    let size = u32_of(request, "size") as u8;
    let strength = request["strength"].as_f64().map(|v| v as f32);
    let direct = request["direct"].as_bool().unwrap_or(false);
    let cancel = AtomicBool::new(false);

    let result = if direct {
        match strength {
            Some(strength) => pipeline::apply_direct_with_cancel_strength(
                Path::new(&src),
                Path::new(&dst),
                &params,
                strength,
                &cancel,
            ),
            None => {
                pipeline::apply_direct_with_cancel(Path::new(&src), Path::new(&dst), &params, &cancel)
            }
        }
    } else {
        let table = lut::bake_parallel(&params, size, 2);
        match strength {
            Some(strength) => pipeline::apply_lut_with_cancel_strength(
                Path::new(&src),
                Path::new(&dst),
                &table,
                strength,
                &cancel,
            ),
            None => pipeline::apply_lut_with_cancel(Path::new(&src), Path::new(&dst), &table, &cancel),
        }
    };

    match result {
        Ok(info) => json!({
            "ok": true,
            "info": {
                "width": info.width,
                "height": info.height,
                "bit_depth": info.bit_depth,
                "icc_profile_bytes": info.icc_profile_bytes,
                "metadata_preserved": info.metadata_preserved,
            },
        }),
        Err(err) => json!({ "ok": false, "error": err.to_string() }),
    }
}

fn jpeg(request: &Value) -> Value {
    let width = u32_of(request, "width");
    let height = u32_of(request, "height");
    let quality = u32_of(request, "quality") as u8;
    let values = f32s(request, "pixels");
    let pixels: Vec<[f32; 3]> = values
        .chunks_exact(3)
        .map(|px| [px[0], px[1], px[2]])
        .collect();
    match io::encode_jpeg(&pixels, width, height, quality) {
        Ok(bytes) => json!({ "ok": true, "len": bytes.len(), "bytes": bytes }),
        Err(err) => json!({ "ok": false, "error": err.to_string() }),
    }
}

/// Deterministic 16-bit TIFF fixtures for the transform tests.
fn fixture(request: &Value) -> Value {
    use std::fs::File;
    use std::io::BufWriter;
    use tiff::encoder::{colortype, Compression, TiffEncoder};

    let path = string(request, "path");
    let width = u32_of(request, "width");
    let height = u32_of(request, "height");
    let kind = request["kind"].as_str().unwrap_or("ramp").to_string();
    let compression = request["compression"].as_str().unwrap_or("none").to_string();
    let rows_per_strip = request["rows_per_strip"].as_u64().map(|v| v as u32);

    let mut data: Vec<u16> = Vec::with_capacity((width * height * 3) as usize);
    for y in 0..height {
        for x in 0..width {
            let (r, g, b) = match kind.as_str() {
                "ramp" => (
                    x * 65535 / width.max(1),
                    y * 65535 / height.max(1),
                    32768,
                ),
                "wide" => (
                    x * 65535 / width.max(1),
                    y * 65535 / height.max(1),
                    (x + y) * 65535 / (width + height).max(1),
                ),
                _ => {
                    let seed = (x * 7919 + y * 104729) as u32;
                    let r = seed.wrapping_mul(2654435761) % 65536;
                    let g = seed.wrapping_mul(40503) % 65536;
                    let b = seed.wrapping_add(12345) % 65536;
                    (r, g, b)
                }
            };
            data.push(r as u16);
            data.push(g as u16);
            data.push(b as u16);
        }
    }

    let file = File::create(&path).unwrap();
    let mut encoder = TiffEncoder::new(BufWriter::new(file)).unwrap();
    encoder = match compression.as_str() {
        "lzw" => encoder.with_compression(Compression::Lzw),
        "deflate" => encoder.with_compression(Compression::Deflate(Default::default())),
        _ => encoder.with_compression(Compression::Uncompressed),
    };
    match rows_per_strip {
        Some(rows) => {
            let mut image = encoder
                .new_image::<colortype::RGB16>(width, height)
                .unwrap();
            image.rows_per_strip(rows).unwrap();
            image.write_data(&data).unwrap();
        }
        None => {
            encoder
                .write_image::<colortype::RGB16>(width, height, &data)
                .unwrap();
        }
    }
    json!({ "ok": true, "samples": data.len() })
}

fn png16(request: &Value) -> Value {
    let path = string(request, "path");
    let width = u32_of(request, "width");
    let height = u32_of(request, "height");
    let values = f32s(request, "pixels");
    let pixels: Vec<[f32; 3]> = values
        .chunks_exact(3)
        .map(|px| [px[0], px[1], px[2]])
        .collect();
    let thumb = Thumb::new(width, height, pixels).unwrap();
    match io::thumb::save_png16(&thumb, Path::new(&path)) {
        Ok(()) => json!({ "ok": true }),
        Err(err) => json!({ "ok": false, "error": err.to_string() }),
    }
}

/// Decodes a 16-bit TIFF back to f32 pixels (used to read a written result).
fn raw_pixels(request: &Value) -> Value {
    let path = string(request, "path");
    let width = u32_of(request, "width");
    let height = u32_of(request, "height");
    match io::thumb::resample_tiff(Path::new(&path), width, height) {
        Ok(pixels) => json!({ "ok": true, "bits": bits(&flat(&pixels)) }),
        Err(err) => json!({ "ok": false, "error": err.to_string() }),
    }
}

fn predict(request: &Value) -> Value {
    let content = string(request, "content");
    let style = string(request, "style");
    let model = string(request, "model");

    let content_thumb = io::thumb::thumbnail_any(Path::new(&content), INPUT_SIZE)
        .unwrap_or_else(|err| fail(&err.to_string()));
    let style_thumb = io::thumb::thumbnail_any(Path::new(&style), INPUT_SIZE)
        .unwrap_or_else(|err| fail(&err.to_string()));

    let mut predictor = match infer::onnx::OnnxPredictor::load(Path::new(&model), 1) {
        Ok(predictor) => predictor,
        Err(err) => return json!({ "ok": false, "error": err.to_string() }),
    };
    match predictor.predict(&content_thumb, &style_thumb) {
        Ok(params) => json!({
            "ok": true,
            "bits": bits(&params.to_vec()),
            "content_thumb": bits(&flat(&content_thumb.pixels)),
            "style_thumb": bits(&flat(&style_thumb.pixels)),
        }),
        Err(err) => json!({ "ok": false, "error": err.to_string() }),
    }
}
