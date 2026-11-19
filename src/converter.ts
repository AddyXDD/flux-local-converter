import { parse as parseYaml } from 'yaml';

export type Kind = 'image' | 'data' | 'text' | 'document' | 'unsupported';
export type FluxFile = { id: string; file: File; ext: string; kind: Kind; target: string; sourcePath?: string; mismatch?: string; status?: string; error?: string };
const imageFormats = ['png', 'jpg', 'webp', 'bmp'];
const dataFormats = ['json', 'yaml', 'csv', 'xml', 'txt', 'md'];
const documentFormats: Record<string,string[]> = { pdf:['docx','txt','html'], pptx:['docx','pdf','txt','html'], docx:['pdf','txt','html'] };
const documentSet = new Set(Object.keys(documentFormats));
const extOf = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';

const imageSet = new Set(['png','jpg','jpeg','webp','bmp','gif','tif','tiff','avif','heic','ico']);
async function actualImageFormat(file:File):Promise<string|undefined>{
  const b=new Uint8Array(await file.slice(0,32).arrayBuffer());
  if(b.length>=8&&b[0]===137&&b[1]===80&&b[2]===78&&b[3]===71)return 'png';
  if(b.length>=3&&b[0]===255&&b[1]===216&&b[2]===255)return 'jpg';
  if(b.length>=12&&String.fromCharCode(...b.slice(0,4))==='RIFF'&&String.fromCharCode(...b.slice(8,12))==='WEBP')return 'webp';
  if(b.length>=2&&b[0]===0x42&&b[1]===0x4d)return 'bmp';
  if(b.length>=6&&['GIF87a','GIF89a'].includes(String.fromCharCode(...b.slice(0,6))))return 'gif';
  if(b.length>=4&&((b[0]===0x49&&b[1]===0x49&&b[2]===0x2a&&b[3]===0)||(b[0]===0x4d&&b[1]===0x4d&&b[2]===0&&b[3]===0x2a)))return 'tiff';
  if(b.length>=12&&String.fromCharCode(...b.slice(4,8))==='ftyp'){const brand=String.fromCharCode(...b.slice(8,12));if(['avif','avis'].includes(brand))return 'avif';if(['heic','heix','hevc','hevx','mif1','msf1'].includes(brand))return 'heic';}
  return undefined;
}
export async function detect(file: File, sourcePath?: string): Promise<FluxFile> {
  const claimed = extOf(file.name);
  const sniffed = imageSet.has(claimed) ? await actualImageFormat(file) : undefined;
  const ext = sniffed ?? claimed;
  const matchesAlias = (sniffed==='jpg'&&claimed==='jpeg')||(sniffed==='tiff'&&claimed==='tif');
  let mismatch = imageSet.has(claimed) ? sniffed ? (sniffed!==claimed&&!matchesAlias?`Extension says .${claimed}, but the file signature is ${sniffed.toUpperCase()}.` : undefined) : `The file does not have a recognized ${claimed.toUpperCase()} image signature.` : undefined;
  let documentType: string | undefined;
  if(!mismatch&&claimed==='pdf') { const header=new TextDecoder().decode(await file.slice(0,1024).arrayBuffer());if(header.indexOf('%PDF-')<0)mismatch='The file does not contain a valid PDF signature.';else documentType='pdf'; }
  if(!mismatch&&['docx','pptx'].includes(claimed)) { try { const JSZip=(await import('jszip')).default;const zip=await JSZip.loadAsync(await file.arrayBuffer());const isDocx=!!zip.file('word/document.xml');const isPptx=!!zip.file('ppt/presentation.xml');if(isDocx===isPptx)mismatch=`The file does not contain a valid ${claimed.toUpperCase()} document structure.`;else {documentType=isDocx?'docx':'pptx';if(documentType!==claimed)mismatch=`Extension says .${claimed}, but the document contents are ${documentType.toUpperCase()}.`;}}catch{mismatch=`The file is not a valid ${claimed.toUpperCase()} package.`;} }
  const kind: Kind = mismatch ? 'unsupported' : documentType ? 'document' : imageFormats.includes(ext) ? 'image' : ['json','yaml','yml','csv','xml'].includes(ext) ? 'data' : ['txt','md'].includes(ext) ? 'text' : 'unsupported';
  const targets = kind === 'image' ? imageFormats.filter(x => x !== ext && !(x === 'jpg' && ext === 'jpeg')) : kind === 'data' ? dataFormats.filter(x => x !== ext && !(x === 'yaml' && ext === 'yml')) : kind === 'text' ? ['txt','md','html'].filter(x => x !== ext) : kind === 'document' ? documentFormats[documentType!] : [];
  return { id: crypto.randomUUID(), file, ext:documentType??ext, kind, target: targets[0] ?? '', sourcePath, mismatch };
}
export function targetsFor(item: FluxFile) {
  return item.kind === 'image' ? imageFormats.filter(x => x !== item.ext && !(x === 'jpg' && item.ext === 'jpeg')) : item.kind === 'data' ? dataFormats.filter(x => x !== item.ext && !(x === 'yaml' && item.ext === 'yml')) : item.kind === 'text' ? ['txt','md','html'].filter(x => x !== item.ext) : item.kind === 'document' ? documentFormats[item.ext] ?? [] : [];
}
const parseCsv = (s: string) => {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false, afterQuote = false;
  for (let i=0;i<s.length;i++) {
    const c=s[i];
    if(quoted){if(c==='"'&&s[i+1]==='"'){cell+='"';i++;}else if(c==='"'){quoted=false;afterQuote=true;}else cell+=c;continue;}
    if(afterQuote){if(c===','){row.push(cell);cell='';afterQuote=false;continue;}if(c==='\n'||(c==='\r'&&s[i+1]==='\n')){row.push(cell);rows.push(row);row=[];cell='';afterQuote=false;if(c==='\r')i++;continue;}throw new Error('CSV has characters after a closing quote.');}
    if(c==='"'){if(cell.length)throw new Error('CSV has a quote in the middle of an unquoted cell.');quoted=true;}
    else if(c===','){row.push(cell);cell='';}
    else if(c==='\n'){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}
    else cell+=c;
  }
  if(quoted) throw new Error('CSV has an unclosed quoted cell.');
  if(cell||row.length){row.push(cell.replace(/\r$/,''));rows.push(row);} return rows;
};
const yamlScalar = (v: unknown): string => v === null ? 'null' : typeof v === 'string' ? JSON.stringify(v) : typeof v === 'object' ? JSON.stringify(v) : String(v);
function yaml(value: unknown, depth=0): string {
  const pad='  '.repeat(depth);
  if(Array.isArray(value)) return value.map(v => `${pad}- ${v && typeof v==='object' ? `\n${yaml(v,depth+1)}` : yamlScalar(v)}`).join('\n');
  if(value && typeof value==='object') return Object.entries(value as Record<string,unknown>).map(([k,v])=>`${pad}${JSON.stringify(k)}: ${v && typeof v==='object' ? `\n${yaml(v,depth+1)}` : yamlScalar(v)}`).join('\n');
  return `${pad}${yamlScalar(value)}`;
}
const xmlEscape=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
function toXml(value: unknown, name='root'): string { const tag=name.replace(/[^\w.-]/g,'_')||'item'; if(Array.isArray(value)) return `<${tag}>${value.map(v=>toXml(v,'item')).join('')}</${tag}>`; if(value && typeof value==='object') return `<${tag}>${Object.entries(value as Record<string,unknown>).map(([k,v])=>toXml(v,k)).join('')}</${tag}>`; return `<${tag}>${xmlEscape(String(value??''))}</${tag}>`; }
function fromXml(s: string): unknown {
  const doc = new DOMParser().parseFromString(s,'application/xml'); if(doc.querySelector('parsererror')) throw new Error('This XML file is not valid.');
  const elements=[...doc.getElementsByTagName('*')];
  if(elements.some(el=>el.attributes.length>0))throw new Error('This XML uses attributes or namespaces, which this build cannot preserve in JSON.');
  if(elements.some(el=>el.children.length>0&&[...el.childNodes].some(n=>(n.nodeType===3||n.nodeType===4)&&!!n.textContent?.trim())))throw new Error('This XML uses mixed text and child elements, which this build cannot preserve in JSON.');
  const node=(el: Element): unknown => { const children=[...el.children]; if(!children.length) return el.textContent??''; const out:Record<string,unknown>={}; for(const c of children){const v=node(c); if(c.tagName in out) out[c.tagName]=Array.isArray(out[c.tagName])?[...(out[c.tagName] as unknown[]),v]:[out[c.tagName],v]; else out[c.tagName]=v;} return out; };
  return node(doc.documentElement);
}
function csvToJson(s:string): unknown[] { const rows=parseCsv(s); if(rows.length<2) throw new Error('CSV needs a header and at least one row.'); const [headers,...body]=rows; if(new Set(headers).size!==headers.length||headers.some(h=>!h)) throw new Error('CSV headers must be non-empty and unique.'); for(let i=0;i<body.length;i++)if(body[i].length!==headers.length)throw new Error(`CSV row ${i+2} has ${body[i].length} cells; expected ${headers.length}.`); return body.map(row=>Object.fromEntries(headers.map((h,i)=>[h,row[i]]))); }
function jsonToCsv(value: unknown): string { if(!Array.isArray(value)||!value.length||!value.every(v=>v&&typeof v==='object'&&!Array.isArray(v))) throw new Error('JSON to CSV needs a non-empty array of objects.'); const headers=[...new Set(value.flatMap(v=>Object.keys(v as object)))]; const cell=(v:unknown)=>{const s=typeof v==='object'&&v!==null?JSON.stringify(v):String(v??'');return /[",\r\n]/.test(s)?`"${s.replaceAll('"','""')}"`:s;}; return [headers.map(cell).join(','),...value.map(v=>headers.map(h=>cell((v as Record<string,unknown>)[h])).join(','))].join('\r\n'); }
export async function convert(item: FluxFile, target: string, onProgress?: (message: string) => void, signal?: AbortSignal): Promise<Blob> {
  if (signal?.aborted) throw new DOMException('Export canceled.', 'AbortError');
  if(item.kind==='image') return convertImage(item.file,item.ext,target);
  if(item.kind==='document') return (await import('./documents')).convertDocument(item.file,item.ext,target,onProgress,signal);
  const text=await item.file.text(); let value: unknown;
  if (signal?.aborted) throw new DOMException('Export canceled.', 'AbortError');
  if(item.ext==='json') { try { value=JSON.parse(text); } catch { throw new Error('This JSON file is invalid.'); } }
  else if(item.ext==='csv') value=csvToJson(text);
  else if(item.ext==='xml') value=fromXml(text);
  else if(['yaml','yml'].includes(item.ext)) { try { value=parseYaml(text,{uniqueKeys:true}); } catch(e) { throw new Error(`This YAML file is invalid: ${e instanceof Error?e.message:'parse error'}`); } }
  else value=text;
  let out: string;
  if(target==='json') out=JSON.stringify(value,null,2)+'\n';
  else if(target==='yaml') out=yaml(value)+'\n';
  else if(target==='xml') out='<?xml version="1.0" encoding="UTF-8"?>\n'+toXml(value)+'\n';
  else if(target==='csv') out=jsonToCsv(value)+'\n';
  else if(target==='html') out=`<!doctype html><meta charset="utf-8"><pre>${xmlEscape(String(value))}</pre>`;
  else out=typeof value==='string'?value:JSON.stringify(value,null,2)+'\n';
  return new Blob([out],{type: target==='json'?'application/json':target==='html'?'text/html':'text/plain;charset=utf-8'});
}
async function convertImage(file:File,sourceExt:string,target:string):Promise<Blob>{
  if(file.type==='image/svg+xml'||file.name.toLowerCase().endsWith('.svg')) throw new Error('SVG rasterization is not available in this build.');
  const signature=await actualImageFormat(file);const expected=sourceExt==='jpeg'?'jpg':sourceExt==='tif'?'tiff':sourceExt;if(signature!==expected)throw new Error(`The file contents do not match the detected ${sourceExt.toUpperCase()} type.`);
  const sourceMime=expected==='jpg'?'image/jpeg':`image/${expected}`;
  // Native file-picker reads have no MIME type. Give WebView2 the verified source
  // type explicitly so it chooses the correct decoder instead of reporting a
  // misleading “codec not available in this build” error.
  let bmp:ImageBitmap;try{bmp=await createImageBitmap(new Blob([file],{type:sourceMime}));}catch{throw new Error(`FLUX verified this as ${sourceExt.toUpperCase()}, but the local Windows image decoder could not read it. The image may be damaged or its codec is missing from WebView2.`);} if(bmp.width*bmp.height>10_000_000){bmp.close();throw new Error('This image is too large for the current safe conversion limit (10 megapixels).');} if(target==='bmp'&&bmp.width*bmp.height*3>8*1024*1024){bmp.close();throw new Error('The BMP output would exceed the safe 8 MB output limit.');} const canvas=document.createElement('canvas'); canvas.width=bmp.width;canvas.height=bmp.height; const ctx=canvas.getContext('2d'); if(!ctx){bmp.close();throw new Error('Could not initialize image conversion.');}
  if(target==='jpg'||target==='bmp') {ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);} ctx.drawImage(bmp,0,0); bmp.close();
  if(target==='bmp') { const {data,width,height}=ctx.getImageData(0,0,canvas.width,canvas.height); const stride=Math.ceil(width*3/4)*4; const bytes=new Uint8Array(54+stride*height); const view=new DataView(bytes.buffer); bytes[0]=0x42;bytes[1]=0x4d;view.setUint32(2,bytes.length,true);view.setUint32(10,54,true);view.setUint32(14,40,true);view.setInt32(18,width,true);view.setInt32(22,height,true);view.setUint16(26,1,true);view.setUint16(28,24,true);view.setUint32(34,stride*height,true); for(let y=0;y<height;y++)for(let x=0;x<width;x++){const si=((height-1-y)*width+x)*4,di=54+y*stride+x*3;bytes[di]=data[si+2];bytes[di+1]=data[si+1];bytes[di+2]=data[si];} return new Blob([bytes],{type:'image/bmp'}); }
  const mime=target==='jpg'?'image/jpeg':`image/${target}`; return new Promise((resolve,reject)=>canvas.toBlob(b=>b&&b.type===mime?resolve(b):reject(new Error(`This device cannot create a genuine ${target.toUpperCase()} image.`)),mime,target==='jpg'||target==='webp'?0.92:undefined));
}
export function outputName(item:FluxFile,target:string){return `${item.file.name.replace(/\.[^.]+$/,'')}.${target==='jpeg'?'jpg':target}`;}

