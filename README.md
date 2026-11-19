# FLUX - Local File Converter

FLUX is a compact Windows desktop widget built with Tauri 2, Rust, React, and TypeScript. It is not Electron, a website, or a local web server. The interface and conversion code are packaged with the app. WebView2 is the Windows rendering runtime and the installer bundles its offline runtime installer.

## Desktop behavior

- A compact circular donut sits on the Windows desktop wallpaper layer. It has no frame, can be moved by dragging while the desktop is visible, remembers its position, is hidden from the taskbar, and stays behind ordinary application windows.
- The idle donut shows no format labels. Drop or select a supported file and the ring reveals only compatible output formats.
- FLUX starts with Windows after installation. Drop files onto the donut, use its native file picker, or right-click a supported file and choose **Convert with FLUX**. On Windows 11 this appears in the compact menu; the legacy entry remains under **Show more options** as a fallback.
- Batch conversion offers only formats supported by every selected file. Converted results are saved separately; input files are read as-is and are never overwritten or modified.
- The installer registers the Windows 11 compact Explorer menu through a native `IExplorerCommand` extension and a sparse identity package, plus per-user legacy menu entries for supported image, data, text, and document types. The uninstaller removes both registrations.
- Output paths default beside the source. The native layer checks supported output signatures and commits output atomically. The app never writes into the source file.
- No external network requests, telemetry, analytics, or engine downloads. The content security policy permits same-origin packaged assets only. PDF.js, its workers and fonts, Tesseract OCR, and its English language model are included locally.

## Supported conversions

Only these pairs are offered by this build:

| Source | Available outputs |
| --- | --- |
| PNG, JPG/JPEG, WebP, BMP | Each other format; BMP encoding is built in and PNG/JPEG/WebP use the bundled local WebView2 codecs |
| JSON | YAML, XML, CSV, TXT, Markdown |
| YAML/YML | JSON, XML, CSV, TXT, Markdown |
| CSV | JSON, YAML, XML, TXT, Markdown |
| XML | JSON, YAML, CSV, TXT, Markdown |
| TXT, Markdown | Each other format, HTML |
| PDF | DOCX, TXT, HTML |
| PPTX | DOCX, PDF, TXT, HTML |
| DOCX | PDF, TXT, HTML |

PDF conversions keep each page as a lossless image instead of rebuilding its layout from copied paragraphs. PDF-to-DOCX keeps the page appearance and includes hidden OCR text plus accessible page descriptions. PDF-to-HTML keeps the page images with hidden OCR text and accessible descriptions. PDF-to-TXT uses embedded text where available and local English OCR on scanned pages.

DOCX-to-PDF uses the bundled offline Word renderer and exports each rendered page as a raster image. This preserves the renderer's appearance but does not guarantee Microsoft Word-identical pagination, and the PDF currently has no OCR text layer. DOCX-to-HTML renders the document structure and adds OCR descriptions to rendered pages. DOCX-to-TXT extracts real document text and falls back to local OCR when the document has no readable text.

PDF-to-DOCX keeps each page as an image with hidden OCR text and accessible descriptions; the page artwork is not editable text. PDF-to-HTML keeps page images with hidden OCR text. DOCX-to-PDF is image-only. OCR currently supports English. OCR/page-image conversions are limited to 50 pages, 16 megapixels per page, and a 22 MB image budget per output. Password-protected documents and legacy `.doc`/`.ppt` files are not supported. PPTX conversion currently extracts slide text and does not preserve slide artwork or animations.

Image conversions inspect file signatures rather than trusting extensions and MIME types. JPEG and BMP outputs flatten transparency on white. Image metadata is not retained. The app rejects images above 10 megapixels.

JSON, XML, YAML, and CSV are parsed before conversion. Invalid structured data, malformed CSV quoting, duplicate/empty CSV headers, or inconsistent CSV row lengths fail instead of silently losing data.

## Limits

- Input files: up to 16 MB. Output files: up to 32 MB.
- Document packages: up to 128 MB expanded size; text extraction accepts PDFs up to 3,000 pages; OCR/page-image conversion accepts up to 50 pages; presentations accept up to 2,000 slides.
- No audio/video conversion, archives, ebooks, legacy Office files, HEIC/AVIF/TIFF/SVG image codecs, or PDF merging/splitting.
- Batch jobs run sequentially and ask for an output path per converted file.

## Build

Requirements: Node.js, Rust with the MSVC toolchain, and Microsoft C++ Build Tools.

```powershell
npm install
npm run desktop
npm run desktop:build
```

The Windows NSIS installer is written to `src-tauri/target/release/bundle/nsis/` and copied, signed, and hashed under `outputs/`. Build the Windows 11 shell extension with a locally held signing PFX and `FLUX_SHELL_SIGNING_PASSWORD` set in the build environment; the PFX stays outside the project and installer while the app, native DLL, and sparse package are signed with it. This local self-signed build requests one admin approval to trust its signer in Local Machine → Trusted People; the uninstaller offers to remove that certificate. Public distribution needs a trusted publisher certificate. The optional local development preview is `npm run dev`; the installed app needs no browser tab or local server.
