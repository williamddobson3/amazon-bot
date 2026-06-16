//! napi-rs build hook — emits the C symbol shims Node-API requires.
//! Without this, the cdylib compiles but Node cannot find the entry
//! point and `require('./crawler/index.node')` fails at runtime.

extern crate napi_build;

fn main() {
    napi_build::setup();
}
