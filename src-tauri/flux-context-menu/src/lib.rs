#![allow(non_snake_case)]

use std::{
    ffi::c_void, ffi::OsString, iter::once, os::windows::ffi::OsStringExt, path::PathBuf,
    process::Command,
};

use windows::{
    core::{
        implement, w, ComObject, Error, IUnknown, IUnknown_Vtbl, Interface, Ref, Result, GUID,
        HRESULT, PCWSTR, PWSTR,
    },
    Win32::{
        Foundation::{
            CLASS_E_CLASSNOTAVAILABLE, CLASS_E_NOAGGREGATION, E_INVALIDARG, E_NOTIMPL, E_POINTER,
            HMODULE,
        },
        System::{
            Com::{CoTaskMemFree, IClassFactory, IClassFactory_Impl},
            LibraryLoader::{
                GetModuleFileNameW, GetModuleHandleExW, GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
                GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            },
        },
        UI::Shell::{
            IEnumExplorerCommand, IExplorerCommand, IExplorerCommand_Impl, IShellItemArray,
            SHStrDupW, ECF_DEFAULT, ECS_ENABLED, ECS_HIDDEN, SIGDN_FILESYSPATH,
        },
    },
};

const CLASS_ID: GUID = GUID::from_u128(0x6e94a2d5_68d6_4c0a_9e5d_07f5b9f0a241);
const COMMAND_ID: GUID = GUID::from_u128(0xd6cce953_4e8d_48ae_8b0c_47c251f9912a);
const ERROR_CLASS_NOT_AVAILABLE: HRESULT = CLASS_E_CLASSNOTAVAILABLE;
const ERROR_NO_AGGREGATION: HRESULT = CLASS_E_NOAGGREGATION;
const ERROR_INVALID_ARGUMENT: HRESULT = E_INVALIDARG;
const ERROR_FAIL: HRESULT = HRESULT(0x80004005u32 as i32);

#[implement(IExplorerCommand)]
struct FluxContextCommand;

#[implement(IClassFactory)]
struct FluxCommandFactory;

impl IExplorerCommand_Impl for FluxContextCommand_Impl {
    fn GetTitle(&self, _items: Ref<IShellItemArray>) -> Result<PWSTR> {
        unsafe { SHStrDupW(w!("Convert with FLUX")) }
    }

    fn GetIcon(&self, _items: Ref<IShellItemArray>) -> Result<PWSTR> {
        let mut icon = installed_executable()?.to_string_lossy().into_owned();
        icon.push_str(",0");
        let wide = icon.encode_utf16().chain(once(0)).collect::<Vec<_>>();
        unsafe { SHStrDupW(PCWSTR::from_raw(wide.as_ptr())) }
    }

    fn GetToolTip(&self, _items: Ref<IShellItemArray>) -> Result<PWSTR> {
        Err(Error::from(E_NOTIMPL))
    }

    fn GetCanonicalName(&self) -> Result<GUID> {
        Ok(COMMAND_ID)
    }

    fn GetState(
        &self,
        items: Ref<IShellItemArray>,
        _ok_to_be_slow: windows::core::BOOL,
    ) -> Result<u32> {
        let paths = match selected_paths(items) {
            Ok(paths) if !paths.is_empty() => paths,
            _ => return Ok(ECS_HIDDEN.0 as u32),
        };
        if paths.iter().all(|path| is_supported(path)) {
            Ok(ECS_ENABLED.0 as u32)
        } else {
            Ok(ECS_HIDDEN.0 as u32)
        }
    }

    fn Invoke(
        &self,
        items: Ref<IShellItemArray>,
        _bind_context: Ref<windows::Win32::System::Com::IBindCtx>,
    ) -> Result<()> {
        let paths = selected_paths(items)?;
        if paths.is_empty() || paths.iter().any(|path| !is_supported(path)) {
            return Err(Error::from(ERROR_INVALID_ARGUMENT));
        }
        Command::new(installed_executable()?)
            .arg("--convert")
            .args(paths)
            .spawn()
            .map_err(|_| Error::from(ERROR_FAIL))?;
        Ok(())
    }

    fn GetFlags(&self) -> Result<u32> {
        Ok(ECF_DEFAULT.0 as u32)
    }

    fn EnumSubCommands(&self) -> Result<IEnumExplorerCommand> {
        Err(Error::from(E_NOTIMPL))
    }
}

impl IClassFactory_Impl for FluxCommandFactory_Impl {
    fn CreateInstance(
        &self,
        outer: Ref<IUnknown>,
        iid: *const GUID,
        output: *mut *mut c_void,
    ) -> Result<()> {
        if output.is_null() || iid.is_null() {
            return Err(Error::from(E_POINTER));
        }
        unsafe { *output = std::ptr::null_mut() };
        if !outer.is_null() {
            return Err(Error::from(ERROR_NO_AGGREGATION));
        }
        let command = ComObject::new(FluxContextCommand).into_interface::<IExplorerCommand>();
        query_interface(command.as_raw(), iid, output)
    }

    fn LockServer(&self, _lock: windows::core::BOOL) -> Result<()> {
        Ok(())
    }
}

#[no_mangle]
pub unsafe extern "system" fn DllGetClassObject(
    class_id: *const GUID,
    iid: *const GUID,
    output: *mut *mut c_void,
) -> HRESULT {
    if class_id.is_null() || iid.is_null() || output.is_null() {
        return E_POINTER;
    }
    unsafe { *output = std::ptr::null_mut() };
    if unsafe { *class_id } != CLASS_ID {
        return ERROR_CLASS_NOT_AVAILABLE;
    }
    let factory = ComObject::new(FluxCommandFactory).into_interface::<IClassFactory>();
    match query_interface(factory.as_raw(), iid, output) {
        Ok(()) => HRESULT(0),
        Err(error) => error.code(),
    }
}

#[no_mangle]
pub extern "system" fn DllCanUnloadNow() -> HRESULT {
    HRESULT(1) // S_FALSE: let the COM surrogate keep this small command server loaded.
}

fn query_interface(this: *mut c_void, iid: *const GUID, output: *mut *mut c_void) -> Result<()> {
    if this.is_null() || iid.is_null() || output.is_null() {
        return Err(Error::from(E_POINTER));
    }
    let vtable = unsafe { *(this as *mut *const IUnknown_Vtbl) };
    unsafe { ((*vtable).QueryInterface)(this, iid, output).ok() }
}

fn selected_paths(items: Ref<IShellItemArray>) -> Result<Vec<String>> {
    if items.is_null() {
        return Err(Error::from(ERROR_INVALID_ARGUMENT));
    }
    let array = items
        .as_ref()
        .ok_or_else(|| Error::from(ERROR_INVALID_ARGUMENT))?;
    let count = unsafe { array.GetCount()? };
    let mut paths = Vec::with_capacity(count as usize);
    for index in 0..count {
        let item = unsafe { array.GetItemAt(index)? };
        let display_name = unsafe { item.GetDisplayName(SIGDN_FILESYSPATH)? };
        let path =
            unsafe { display_name.to_string() }.map_err(|_| Error::from(ERROR_INVALID_ARGUMENT))?;
        unsafe { CoTaskMemFree(Some(display_name.0 as *const c_void)) };
        if path.is_empty() {
            return Err(Error::from(ERROR_INVALID_ARGUMENT));
        }
        paths.push(path);
    }
    Ok(paths)
}

fn is_supported(path: &str) -> bool {
    PathBuf::from(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "png"
                    | "jpg"
                    | "jpeg"
                    | "webp"
                    | "bmp"
                    | "json"
                    | "csv"
                    | "xml"
                    | "txt"
                    | "md"
                    | "yaml"
                    | "yml"
                    | "pdf"
                    | "docx"
                    | "pptx"
            )
        })
}

fn installed_executable() -> Result<PathBuf> {
    let module_address = DllGetClassObject as *const () as *const u16;
    let mut module = HMODULE::default();
    unsafe {
        GetModuleHandleExW(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            PCWSTR::from_raw(module_address),
            &mut module,
        )?;
    }
    let mut buffer = vec![0u16; 32_768];
    let length = unsafe { GetModuleFileNameW(Some(module), &mut buffer) } as usize;
    if length == 0 || length >= buffer.len() {
        return Err(Error::from(ERROR_FAIL));
    }
    let dll_path = PathBuf::from(OsString::from_wide(&buffer[..length]));
    for directory in [
        dll_path.parent(),
        dll_path.parent().and_then(|parent| parent.parent()),
    ]
    .into_iter()
    .flatten()
    {
        let executable = directory.join("flux.exe");
        if executable.is_file() {
            return Ok(executable);
        }
    }
    Err(Error::new(
        ERROR_FAIL,
        format!("FLUX was not found beside {}", dll_path.display()),
    ))
}

#[cfg(test)]
mod tests {
    use super::is_supported;

    #[test]
    fn shows_the_menu_for_every_supported_input_extension() {
        for path in [
            "photo.png",
            "photo.jpg",
            "photo.jpeg",
            "photo.webp",
            "photo.bmp",
            "data.json",
            "data.csv",
            "data.xml",
            "notes.txt",
            "notes.md",
            "config.yaml",
            "config.yml",
            "scan.pdf",
            "slides.docx",
            "slides.pptx",
        ] {
            assert!(is_supported(path), "expected {path} to be supported");
        }
    }

    #[test]
    fn hides_the_menu_for_unsupported_or_extensionless_items() {
        for path in [
            "program.exe",
            "archive.zip",
            "document.doc",
            "README",
            "folder.name\\README",
        ] {
            assert!(!is_supported(path), "expected {path} to be hidden");
        }
    }

    #[test]
    fn matches_extensions_case_insensitively_and_uses_the_final_suffix() {
        assert!(is_supported("C:\\files\\REPORT.PDF"));
        assert!(!is_supported("C:\\files\\report.pdf.exe"));
        assert!(!is_supported("C:\\files.with.dots\\README"));
    }
}
