#![allow(non_snake_case)]

use std::{
    ffi::c_void, ffi::OsString, iter::once, os::windows::ffi::OsStringExt, path::PathBuf,
    process::Command, sync::Mutex,
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
            IEnumExplorerCommand, IEnumExplorerCommand_Impl, IExplorerCommand,
            IExplorerCommand_Impl, IShellItemArray, SHStrDupW, ECF_HASSUBCOMMANDS, ECS_ENABLED,
            ECS_HIDDEN, SIGDN_FILESYSPATH,
        },
    },
};

const CLASS_ID: GUID = GUID::from_u128(0x6e94a2d5_68d6_4c0a_9e5d_07f5b9f0a241);
const COMMAND_ID: GUID = GUID::from_u128(0xd6cce953_4e8d_48ae_8b0c_47c251f9912a);
const TARGETS: &[&str] = &[
    "png", "jpg", "webp", "bmp", "pdf", "docx", "txt", "html", "csv", "json", "yaml", "xml", "md",
];
const ERROR_CLASS_NOT_AVAILABLE: HRESULT = CLASS_E_CLASSNOTAVAILABLE;
const ERROR_NO_AGGREGATION: HRESULT = CLASS_E_NOAGGREGATION;
const ERROR_INVALID_ARGUMENT: HRESULT = E_INVALIDARG;
const ERROR_FAIL: HRESULT = HRESULT(0x80004005u32 as i32);

#[implement(IExplorerCommand)]
struct FluxContextCommand;

#[implement(IClassFactory)]
struct FluxCommandFactory;

#[implement(IExplorerCommand)]
struct FluxFormatCommand {
    target: &'static str,
}

#[implement(IEnumExplorerCommand)]
struct FluxCommandEnumerator {
    targets: Vec<&'static str>,
    position: Mutex<usize>,
}

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
        if !common_targets(&paths).is_empty() {
            Ok(ECS_ENABLED.0 as u32)
        } else {
            Ok(ECS_HIDDEN.0 as u32)
        }
    }

    fn Invoke(
        &self,
        _items: Ref<IShellItemArray>,
        _bind_context: Ref<windows::Win32::System::Com::IBindCtx>,
    ) -> Result<()> {
        Err(Error::from(E_NOTIMPL))
    }

    fn GetFlags(&self) -> Result<u32> {
        Ok(ECF_HASSUBCOMMANDS.0 as u32)
    }

    fn EnumSubCommands(&self) -> Result<IEnumExplorerCommand> {
        let enumerator = ComObject::new(FluxCommandEnumerator {
            targets: TARGETS.to_vec(),
            position: Mutex::new(0),
        })
        .into_interface::<IEnumExplorerCommand>();
        Ok(enumerator)
    }
}

impl IExplorerCommand_Impl for FluxFormatCommand_Impl {
    fn GetTitle(&self, _items: Ref<IShellItemArray>) -> Result<PWSTR> {
        duplicate_shell_string(&format!("Convert to {}", self.target.to_ascii_uppercase()))
    }

    fn GetIcon(&self, _items: Ref<IShellItemArray>) -> Result<PWSTR> {
        let mut icon = installed_executable()?.to_string_lossy().into_owned();
        icon.push_str(",0");
        duplicate_shell_string(&icon)
    }

    fn GetToolTip(&self, _items: Ref<IShellItemArray>) -> Result<PWSTR> {
        Err(Error::from(E_NOTIMPL))
    }

    fn GetCanonicalName(&self) -> Result<GUID> {
        let index = TARGETS
            .iter()
            .position(|target| *target == self.target)
            .unwrap_or(0) as u128;
        Ok(GUID::from_u128(
            0x4ebf97bb_8864_4af2_ba47_c5a07a010000 + index,
        ))
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
        if paths
            .iter()
            .all(|path| target_formats(path).contains(&self.target))
        {
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
        if paths.is_empty()
            || paths
                .iter()
                .any(|path| !target_formats(path).contains(&self.target))
        {
            return Err(Error::from(ERROR_INVALID_ARGUMENT));
        }
        Command::new(installed_executable()?)
            .arg("--convert-to")
            .arg(self.target)
            .arg("--convert")
            .args(paths)
            .spawn()
            .map_err(|_| Error::from(ERROR_FAIL))?;
        Ok(())
    }

    fn GetFlags(&self) -> Result<u32> {
        Ok(0)
    }

    fn EnumSubCommands(&self) -> Result<IEnumExplorerCommand> {
        Err(Error::from(E_NOTIMPL))
    }
}

impl IEnumExplorerCommand_Impl for FluxCommandEnumerator_Impl {
    fn Next(
        &self,
        count: u32,
        output: *mut Option<IExplorerCommand>,
        fetched: *mut u32,
    ) -> windows::core::HRESULT {
        if (count > 0 && output.is_null()) || (fetched.is_null() && count != 1) {
            return E_INVALIDARG;
        }
        let mut position = match self.position.lock() {
            Ok(position) => position,
            Err(_) => return ERROR_FAIL,
        };
        let mut written = 0;
        while written < count {
            let Some(target) = self.targets.get(*position).copied() else {
                break;
            };
            let command =
                ComObject::new(FluxFormatCommand { target }).into_interface::<IExplorerCommand>();
            unsafe { output.add(written as usize).write(Some(command)) };
            *position += 1;
            written += 1;
        }
        if !fetched.is_null() {
            unsafe { *fetched = written };
        }
        if written == count {
            windows::core::HRESULT(0)
        } else {
            windows::core::HRESULT(1)
        }
    }

    fn Skip(&self, count: u32) -> Result<()> {
        let mut position = self.position.lock().map_err(|_| Error::from(ERROR_FAIL))?;
        let requested = position.saturating_add(count as usize);
        if requested <= self.targets.len() {
            *position = requested;
            Ok(())
        } else {
            *position = self.targets.len();
            Err(Error::from(windows::core::HRESULT(1)))
        }
    }

    fn Reset(&self) -> Result<()> {
        *self.position.lock().map_err(|_| Error::from(ERROR_FAIL))? = 0;
        Ok(())
    }

    fn Clone(&self) -> Result<IEnumExplorerCommand> {
        let position = *self.position.lock().map_err(|_| Error::from(ERROR_FAIL))?;
        Ok(ComObject::new(FluxCommandEnumerator {
            targets: self.targets.clone(),
            position: Mutex::new(position),
        })
        .into_interface::<IEnumExplorerCommand>())
    }
}

fn duplicate_shell_string(value: &str) -> Result<PWSTR> {
    let wide = value.encode_utf16().chain(once(0)).collect::<Vec<_>>();
    unsafe { SHStrDupW(PCWSTR::from_raw(wide.as_ptr())) }
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

fn target_formats(path: &str) -> Vec<&'static str> {
    let extension = PathBuf::from(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase);
    let Some(extension) = extension.as_deref() else {
        return Vec::new();
    };

    let candidates: &[&str] = match extension {
        "png" | "jpg" | "jpeg" | "webp" | "bmp" | "gif" | "tif" | "tiff" | "avif" | "heic" => {
            &["png", "jpg", "webp", "bmp"]
        }
        "pdf" => &["docx", "txt", "html"],
        "pptx" => &["docx", "pdf", "txt", "html"],
        "docx" => &["pdf", "txt", "html"],
        "json" | "csv" | "xml" | "yaml" | "yml" => &["json", "yaml", "csv", "xml", "txt", "md"],
        "txt" | "md" => &["txt", "md", "html"],
        _ => return Vec::new(),
    };

    candidates
        .iter()
        .copied()
        .filter(|target| match extension {
            "jpeg" | "jpg" => *target != "jpg",
            "yml" | "yaml" => *target != "yaml",
            _ => *target != extension,
        })
        .collect()
}

fn common_targets(paths: &[String]) -> Vec<&'static str> {
    let Some(first) = paths.first() else {
        return Vec::new();
    };
    let first_targets = target_formats(first);
    first_targets
        .into_iter()
        .filter(|target| {
            paths
                .iter()
                .skip(1)
                .all(|path| target_formats(path).contains(target))
        })
        .collect()
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
    use super::{common_targets, target_formats, FluxCommandEnumerator, TARGETS};
    use std::sync::Mutex;
    use windows::{core::ComObject, Win32::UI::Shell::IEnumExplorerCommand};

    #[test]
    fn offers_only_formats_supported_for_each_input_type() {
        let expected = [
            ("photo.png", &["jpg", "webp", "bmp"][..]),
            ("photo.jpeg", &["png", "webp", "bmp"][..]),
            ("photo.gif", &["png", "jpg", "webp", "bmp"][..]),
            ("scan.pdf", &["docx", "txt", "html"][..]),
            ("slides.pptx", &["docx", "pdf", "txt", "html"][..]),
            ("report.docx", &["pdf", "txt", "html"][..]),
            ("table.csv", &["json", "yaml", "xml", "txt", "md"][..]),
            ("config.yml", &["json", "csv", "xml", "txt", "md"][..]),
            ("notes.txt", &["md", "html"][..]),
        ];
        for (path, formats) in expected {
            assert_eq!(target_formats(path), formats, "formats for {path}");
        }
        assert_eq!(TARGETS.len(), 13);
    }

    #[test]
    fn filters_mixed_selection_to_common_output_formats() {
        assert_eq!(
            common_targets(&["slides.pptx".into(), "report.docx".into()]),
            vec!["pdf", "txt", "html"]
        );
        assert!(common_targets(&["photo.png".into(), "scan.pdf".into()]).is_empty());
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
            assert!(
                target_formats(path).is_empty(),
                "expected {path} to be hidden"
            );
        }
    }

    #[test]
    fn matches_extensions_case_insensitively_and_uses_the_final_suffix() {
        assert_eq!(
            target_formats("C:\\files\\REPORT.PDF"),
            vec!["docx", "txt", "html"]
        );
        assert!(target_formats("C:\\files\\report.pdf.exe").is_empty());
        assert!(target_formats("C:\\files.with.dots\\README").is_empty());
    }

    #[test]
    fn enumerates_the_conversion_submenu_without_missing_or_duplicate_commands() {
        let commands = ComObject::new(FluxCommandEnumerator {
            targets: TARGETS.to_vec(),
            position: Mutex::new(0),
        })
        .into_interface::<IEnumExplorerCommand>();
        let mut output: [Option<windows::Win32::UI::Shell::IExplorerCommand>; 13] =
            std::array::from_fn(|_| None);
        let mut fetched = 0;
        let result = unsafe { commands.Next(&mut output, Some(&mut fetched)) };
        assert_eq!(result.0, 0);
        assert_eq!(fetched as usize, TARGETS.len());
        assert!(output.iter().all(Option::is_some));

        let mut one_more = [None];
        fetched = 1;
        let result = unsafe { commands.Next(&mut one_more, Some(&mut fetched)) };
        assert_eq!(result.0, 1);
        assert_eq!(fetched, 0);

        unsafe { commands.Reset().expect("reset submenu iterator") };
        let mut first = [None];
        fetched = 0;
        let result = unsafe { commands.Next(&mut first, Some(&mut fetched)) };
        assert_eq!(result.0, 0);
        assert_eq!(fetched, 1);
    }
}
