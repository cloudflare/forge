//! Plain `wasm32-unknown-unknown` C-ABI entrypoints for `@cloudflare/forge`'s
//! in-process `parse()` function — no `wit-bindgen`, no `jco` component glue,
//! and no leaked `Forge` instances retained across calls.

#[cfg(target_arch = "wasm32")]
mod wasm_exports {
    use core::cell::RefCell;

    use super::super::records::pack_forge;
    use crate::Forge;

    struct Output {
        bytes: Vec<u8>,
        is_err: bool,
    }

    thread_local! {
        static OUT: RefCell<Output> = const {
            RefCell::new(Output {
                bytes: Vec::new(),
                is_err: false,
            })
        };
    }

    /// Parses UTF-8 OpenAPI JSON at `(ptr, len)` into a `Forge`, immediately
    /// packs it into a single `capnstruct` buffer, and drops `Forge`.
    /// Returns `0` on success (packed `ForgeDoc` in `forge_out_ptr/len`) or
    /// `1` on error (UTF-8 error message in `forge_out_ptr/len`).
    #[unsafe(no_mangle)]
    pub extern "C" fn forge_parse(ptr: *const u8, len: u32) -> u32 {
        // SAFETY: JS writes `len` UTF-8 bytes into memory allocated via `capn_alloc`.
        let input = unsafe { core::slice::from_raw_parts(ptr, len as usize) };
        let result = match core::str::from_utf8(input) {
            Ok(text) => serde_json::from_str::<Forge>(text)
                .map(|forge| pack_forge(&forge))
                .map_err(|err| err.to_string().into_bytes()),
            Err(err) => Err(err.to_string().into_bytes()),
        };
        OUT.with(|cell| {
            let mut out = cell.borrow_mut();
            match result {
                Ok(bytes) => {
                    out.bytes = bytes;
                    out.is_err = false;
                    0
                }
                Err(msg) => {
                    out.bytes = msg;
                    out.is_err = true;
                    1
                }
            }
        })
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn forge_out_ptr() -> *const u8 {
        OUT.with(|cell| cell.borrow().bytes.as_ptr())
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn forge_out_len() -> u32 {
        OUT.with(|cell| cell.borrow().bytes.len() as u32)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn forge_clear_out() {
        OUT.with(|cell| {
            let mut out = cell.borrow_mut();
            out.bytes.clear();
            out.bytes.shrink_to_fit();
            out.is_err = false;
        });
    }
}
