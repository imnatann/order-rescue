import "server-only";
export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ChatMessage = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };
export type ChatTool = { type: "function"; function: { name: string; description: string; parameters: Record<string,unknown> } };
export class ProviderError extends Error {
  constructor(message: string,public readonly status=502) { super(message);this.name="ProviderError"; }
}
export function isLlmConfigured() { return Boolean(process.env.LLM_BASE_URL?.trim() && process.env.LLM_API_KEY?.trim() && process.env.LLM_MODEL?.trim()); }
export async function chat(messages: ChatMessage[],options: { tools?: ChatTool[]; signal?: AbortSignal }={}) {
  const base=process.env.LLM_BASE_URL?.trim().replace(/\/+$/,"");const key=process.env.LLM_API_KEY?.trim();const model=process.env.LLM_MODEL?.trim();
  if(!base || !key || !model)throw new ProviderError("Provider LLM belum dikonfigurasi.",503);
  let endpoint:URL;
  try{endpoint=new URL(`${base}/chat/completions`);if(!['http:','https:'].includes(endpoint.protocol)||endpoint.username||endpoint.password)throw new Error();}
  catch{throw new ProviderError("URL provider tidak valid.",503);}
  let response:Response;
  try{response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify({model,messages,stream:false,max_tokens:4096,...(options.tools?{tools:options.tools,tool_choice:'auto'}:{})}),cache:'no-store',signal:AbortSignal.any([AbortSignal.timeout(90_000),...(options.signal?[options.signal]:[])]),redirect:'error'});}
  catch(error){if(options.signal?.aborted)throw new ProviderError("Proses dihentikan.",499);const timeout=error instanceof Error&&['TimeoutError','AbortError'].includes(error.name);throw new ProviderError(timeout?"Provider melewati batas waktu.":"Provider tidak dapat dihubungi.",timeout?504:502);}
  if(!response.ok)throw new ProviderError(response.status===401||response.status===403?"Provider menolak autentikasi server.":response.status===429?"Provider membatasi permintaan; coba kembali.":`Provider gagal (HTTP ${response.status}).`);
  const reader=response.body?.getReader();if(!reader)throw new ProviderError("Respons provider kosong.");
  let size=0;const chunks:Uint8Array[]=[];
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1024*1024){await reader.cancel();throw new ProviderError("Respons provider terlalu besar.");}chunks.push(value);}
  let body:{ choices?: {message?:ChatMessage;finish_reason?:string}[];usage?:{prompt_tokens?:number;completion_tokens?:number;total_tokens?:number} };
  try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ProviderError("Respons provider bukan JSON yang valid.");}
  const choice=body?.choices?.[0];const message=choice?.message;
  if(choice?.finish_reason==='length')throw new ProviderError("Output provider terpotong; coba kembali.");
  if(!message || (typeof message.content!=='string'&&!Array.isArray(message.tool_calls)))throw new ProviderError("Provider tidak mengembalikan pesan atau tool call yang valid.");
  if(message.tool_calls && (message.tool_calls.length>8 || message.tool_calls.some((t) => typeof t.id!=='string'||t.id.length>200||typeof t.function?.name!=='string'||typeof t.function.arguments!=='string'||t.function.arguments.length>32000)))throw new ProviderError("Format tool call provider tidak valid.");
  if(message.content)message.content=message.content.replaceAll(key,'[REDACTED]');
  return {message:{role:'assistant' as const,content:typeof message.content==='string'?message.content:null,...(message.tool_calls?{tool_calls:message.tool_calls}:{})},usage:body.usage??{},model};
}
export async function completeChat(messages:ChatMessage[]) {
  const result=await chat(messages);
  if(!result.message.content?.trim())throw new ProviderError("Provider tidak mengembalikan teks analisis.");
  return {content:result.message.content.trim(),model:result.model};
}
