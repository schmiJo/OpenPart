//! The browser's way into CoreShape. Modelling goes through the same tools an agent uses, so the
//! UI and an AI share one API. The only additions are what a screen needs and a tool shouldn't
//! return as JSON: display meshes, an STL's bytes, and each parameter's current value.
//!
//! Meshes come from the session's own rebuild, so nothing is built twice.

use coreshape::{export, tessellate, Body, TessParams};
use coreshape_document::json::{self, Value};
use coreshape_document::Outcome;
use coreshape_mcp::{Server, Session};
use std::cell::RefCell;
use std::path::PathBuf;
use std::sync::Arc;

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
extern "C" {
    fn sx_on_panic(p: *const u8, n: usize);
}

struct Engine {
    session: Session,
    out: Vec<u8>,
    positions: Vec<f32>,
    normals: Vec<f32>,
    faces: Vec<u32>,
    indices: Vec<u32>,
    segments: Vec<f32>,
    segment_ids: Vec<u32>,
    info: String,
    table: [u32; 14],
}

impl Engine {
    fn new() -> Engine {
        Engine {
            session: Session::new(PathBuf::from("/")),
            out: Vec::new(),
            positions: Vec::new(),
            normals: Vec::new(),
            faces: Vec::new(),
            indices: Vec::new(),
            segments: Vec::new(),
            segment_ids: Vec::new(),
            info: String::new(),
            table: [0; 14],
        }
    }

    /// The model up to a position, or all of it. The session's own outcome is whatever was rebuilt last, which can be
    /// a rollback, so this asks for exactly what it wants. Features that haven't changed aren't built again.
    fn outcome(&mut self, upto: Option<usize>) -> Outcome {
        self.session.outcome_upto(upto)
    }

    fn body(&mut self, upto: Option<usize>) -> Option<Arc<Body>> {
        self.outcome(upto).body
    }

    fn fill_mesh(&mut self, upto: Option<usize>, draft: bool) -> Result<(usize, usize, String), String> {
        self.positions.clear();
        self.normals.clear();
        self.faces.clear();
        self.indices.clear();
        self.segments.clear();
        self.segment_ids.clear();
        let outcome = self.outcome(upto);
        let Some(body) = outcome.body.clone() else { return Ok((0, 0, "[]".to_string())) };
        let size = body.aabb().diagonal();
        // The kernel's display preset turns a small circle into 15 sides, which shows at CAD zoom levels.
        let params = if draft { TessParams::draft_for_size(size) } else { TessParams { chord: (size * 5e-4).max(1e-4), angle: 11f64.to_radians() } };
        let mesh = tessellate(&body, &params).map_err(|e| e.to_string())?;
        for p in &mesh.positions {
            self.positions.extend_from_slice(&[p.x as f32, p.y as f32, p.z as f32]);
        }
        for n in &mesh.normals {
            self.normals.extend_from_slice(&[n.x as f32, n.y as f32, n.z as f32]);
        }
        // Vertices aren't shared between faces, so each vertex has exactly one.
        self.faces.resize(mesh.positions.len(), 0);
        for (t, &f) in mesh.triangles.iter().zip(&mesh.face_of_triangle) {
            for &v in t {
                self.faces[v as usize] = f;
                self.indices.push(v);
            }
        }
        // Closed surfaces are split into half faces, for robustness. The seam between two pieces of one
        // surface isn't a real edge: it would only clutter the view and offer a fillet that means nothing.
        let uses = body.edge_uses();
        for (e, line) in mesh.edge_lines.iter().enumerate() {
            if matches!(uses[e].as_slice(), [a, b] if body.faces[a.0].surface == body.faces[b.0].surface) {
                continue;
            }
            for w in line.windows(2) {
                self.segments.extend_from_slice(&[w[0].x as f32, w[0].y as f32, w[0].z as f32, w[1].x as f32, w[1].y as f32, w[1].z as f32]);
                self.segment_ids.push(e as u32);
            }
        }
        Ok((body.faces.len(), body.edges.len(), parts_json(&outcome, &body)))
    }
}

/// Each body, as `[{"name": "f3", "sheet": false, "faces": [...], "edges": [...]}]`, oldest first. The kernel puts them
/// side by side in one body, so a part's faces and edges are a run of the whole's.
fn parts_json(outcome: &Outcome, whole: &Body) -> String {
    let runs = |starts: Vec<usize>, total: usize| -> Vec<(usize, usize)> {
        (0..starts.len()).map(|i| (starts[i], starts.get(i + 1).copied().unwrap_or(total))).collect()
    };
    let faces = runs(outcome.bodies.iter().map(|b| b.first_face).collect(), whole.faces.len());
    let edges = runs(outcome.bodies.iter().map(|b| b.first_edge).collect(), whole.edges.len());
    let list = |(a, b): (usize, usize)| (a..b).map(|i| i.to_string()).collect::<Vec<_>>().join(",");
    let items: Vec<String> = outcome
        .bodies
        .iter()
        .enumerate()
        .map(|(i, b)| format!("{{\"name\":\"{}\",\"sheet\":{},\"faces\":[{}],\"edges\":[{}]}}", b.id.text(), b.body.sheet, list(faces[i]), list(edges[i])))
        .collect();
    format!("[{}]", items.join(","))
}

thread_local! {
    static ENGINE: RefCell<Engine> = RefCell::new(Engine::new());
}

fn answer(e: &mut Engine, bytes: Vec<u8>) -> *const u8 {
    e.out = bytes;
    e.out.as_ptr()
}

#[no_mangle]
pub extern "C" fn sx_init() {
    #[cfg(target_arch = "wasm32")]
    std::panic::set_hook(Box::new(|info| {
        let message = info.to_string();
        unsafe { sx_on_panic(message.as_ptr(), message.len()) };
    }));
}

#[no_mangle]
pub extern "C" fn sx_alloc(n: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(n);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// Length of the answer the last call returned.
#[no_mangle]
pub extern "C" fn sx_out_len() -> usize {
    ENGINE.with(|e| e.borrow().out.len())
}

/// Calls a tool. Takes ownership of `{"name": ..., "arguments": {...}}`, allocated by `sx_alloc`.
///
/// # Safety
/// `p` must come from `sx_alloc(n)` and hold `n` initialised bytes.
#[no_mangle]
pub unsafe extern "C" fn sx_call(p: *mut u8, n: usize) -> *const u8 {
    let text = String::from_utf8_lossy(&Vec::from_raw_parts(p, n, n)).into_owned();
    ENGINE.with(|e| {
        let mut e = e.borrow_mut();
        let result = match json::parse(&text) {
            Ok(message) => {
                let name = message.get("name").and_then(Value::as_str).unwrap_or("").to_string();
                let empty = Value::Obj(Vec::new());
                e.session.call_safely(&name, message.get("arguments").unwrap_or(&empty))
            }
            Err(why) => Value::obj(vec![
                ("content", Value::Arr(vec![Value::obj(vec![("type", Value::str("text")), ("text", Value::str(format!("not valid JSON: {why}")))])])),
                ("isError", Value::Bool(true)),
            ]),
        };
        answer(&mut e, result.to_text().into_bytes())
    })
}

/// The MCP tool list, with each tool's description and schema, ready to offer to a model.
#[no_mangle]
pub extern "C" fn sx_tools() -> *const u8 {
    let listed = Server::new(PathBuf::from("/"))
        .handle_line(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}"#)
        .unwrap_or_default();
    ENGINE.with(|e| answer(&mut e.borrow_mut(), listed.into_bytes()))
}

/// Every parameter's value as a number, or `{"error": ...}`. The sketch solver wants numbers.
#[no_mangle]
pub extern "C" fn sx_env() -> *const u8 {
    ENGINE.with(|e| {
        let mut e = e.borrow_mut();
        let found = e.session.document().environment().map_err(|x| x.to_string());
        let value = match found {
            Ok(env) => Value::Obj(env.into_iter().map(|(k, v)| (k, Value::Num(v))).collect()),
            Err(why) => Value::obj(vec![("error", Value::str(why))]),
        };
        answer(&mut e, value.to_text().into_bytes())
    })
}

/// Meshes the solid for display. `upto` below zero means the whole history. Returns seven
/// `(pointer, length)` pairs: positions, normals, a face per vertex, triangle indices, edge segments,
/// an edge per segment, and a JSON info string. Indices match `faces_list` and `edges_list`.
#[no_mangle]
pub extern "C" fn sx_mesh(upto: i32, draft: i32) -> *const u32 {
    ENGINE.with(|e| {
        let mut e = e.borrow_mut();
        let e = &mut *e;
        let upto = (upto >= 0).then_some(upto as usize);
        e.info = match e.fill_mesh(upto, draft != 0) {
            Ok((faces, edges, parts)) => format!("{{\"ok\":true,\"faces\":{faces},\"edges\":{edges},\"parts\":{parts}}}"),
            Err(why) => Value::obj(vec![("ok", Value::Bool(false)), ("error", Value::str(why))]).to_text(),
        };
        e.table = [
            e.positions.as_ptr() as u32,
            e.positions.len() as u32,
            e.normals.as_ptr() as u32,
            e.normals.len() as u32,
            e.faces.as_ptr() as u32,
            e.faces.len() as u32,
            e.indices.as_ptr() as u32,
            e.indices.len() as u32,
            e.segments.as_ptr() as u32,
            e.segments.len() as u32,
            e.segment_ids.as_ptr() as u32,
            e.segment_ids.len() as u32,
            e.info.as_ptr() as u32,
            e.info.len() as u32,
        ];
        e.table.as_ptr()
    })
}

/// The solid as binary STL, at export quality. `sx_out_len` of zero means there's no solid.
#[no_mangle]
pub extern "C" fn sx_stl() -> *const u8 {
    ENGINE.with(|e| {
        let mut e = e.borrow_mut();
        let bytes = match e.body(None) {
            Some(body) => tessellate(&body, &TessParams::for_size(body.aabb().diagonal())).map(|m| export::stl::write_binary(&m, "model")).unwrap_or_default(),
            _ => Vec::new(),
        };
        answer(&mut e, bytes)
    })
}
