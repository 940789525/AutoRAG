import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const { AutoRAGAgent, defaultEmbeddingConfig, releaseEmbedders } = await import(process.env.AUTORAG_QA_BUILT === "1" ? "../../dist/index.js" : "../../src/index.ts");
const endpoint = process.env.AUTORAG_QA_EMBED_ENDPOINT;
const tokenizer = process.env.AUTORAG_QA_TOKENIZER;
assert(endpoint && tokenizer, "Set AUTORAG_QA_EMBED_ENDPOINT and AUTORAG_QA_TOKENIZER to an already prepared loopback FastEmbed service and tokenizer directory");
assert(["127.0.0.1", "[::1]"].includes(new URL(endpoint).hostname), "Local model QA requires loopback");
const actualConfig = join(homedir(), ".autorag", "config.json");
const realHash = () => existsSync(actualConfig) ? createHash("sha256").update(readFileSync(actualConfig)).digest("hex") : "ABSENT";
const before = realHash();
const root = mkdtempSync(join(tmpdir(), "autorag-fastembed-live-"));
process.env.AUTORAG_HOME = join(root, "home");
process.env.AUTORAG_CONFIG = join(root, "home", "config.json");
mkdirSync(process.env.AUTORAG_HOME, { recursive: true });
const docs = join(root, "docs"); mkdirSync(docs);
const topics = [
 ["refund", "Refund exceptions require director approval before payout.", "退款例外必须在付款前获得主管批准。", "Who approves refund exceptions?", "退款例外需要谁批准？"],
 ["travel", "International travel reimbursement requires an itemized hotel receipt.", "国际差旅报销必须提供酒店的逐项收据。", "What receipt is required for international travel reimbursement?", "国际差旅报销需要什么收据？"],
 ["security", "Lost security access badges must be reported to the security desk within one hour.", "门禁卡丢失后必须在一小时内向安保处报告。", "When must a lost access badge be reported?", "门禁卡丢失后多久内必须报告？"],
 ["budget", "The annual department budget is approved by the finance committee in December.", "年度部门预算由财务委员会在十二月批准。", "When does the finance committee approve the annual budget?", "财务委员会何时批准年度预算？"],
 ["contract", "Supplier contracts exceeding fifty thousand dollars require legal review.", "超过五万美元的供应商合同需要法律审查。", "Which supplier contracts require legal review?", "哪些供应商合同需要法律审查？"],
 ["retention", "Employee payroll records must be retained for seven years.", "员工工资记录必须保存七年。", "How long are payroll records retained?", "员工工资记录必须保存多久？"],
 ["backup", "Database backups run every night and are stored in the secondary data center.", "数据库每天夜间备份，并保存在备用数据中心。", "Where are nightly database backups stored?", "每晚的数据库备份存放在哪里？"],
 ["research", "Research experiments must record the dataset revision and random seed for reproducibility.", "研究实验必须记录数据集版本和随机种子以便复现。", "What must research experiments record for reproducibility?", "研究实验为了复现需要记录什么？"],
];
for (const [id,en,zh] of topics) { writeFileSync(join(docs, `${id}-en.txt`), en); writeFileSync(join(docs, `${id}-中文.txt`), zh); }

// A valid text PDF and a long, structured bilingual Markdown file exercise parsing and chunk budgets.
const pdfText="Rocket launch vehicles use liquid oxygen and methane as propellants.";
const stream=`BT /F1 12 Tf 30 700 Td (${pdfText}) Tj ET`;
const objects=["<< /Type /Catalog /Pages 2 0 R >>","<< /Type /Pages /Kids [3 0 R] /Count 1 >>","<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>","<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
let pdf="%PDF-1.4\n";const offsets=[0];for(const [i,object] of objects.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${object}\nendobj\n`;}const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset=>`${String(offset).padStart(10,"0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
writeFileSync(join(docs,"launch-guide.pdf"),pdf);
writeFileSync(join(docs,"长篇植物学.md"),"# Leaf anatomy\n\n"+"The botanical survey examines leaf veins, chloroplasts, stomata and photosynthesis. ".repeat(130)+"\n\n## 中文观察\n\n"+"植物学观察记录叶片纹理、叶绿体以及气孔的结构。".repeat(100));
const embedding = defaultEmbeddingConfig();
const local = embedding.profiles[embedding.defaultProfile]; local.baseUrl = endpoint; local.manifest!.tokenizerPath = tokenizer;
embedding.profiles["api-protocol-fixture"] = { ...local, kind: "api", allowRemote: true, allowedConsumers: ["local-documents"] };
embedding.profiles["failed-candidate"] = { ...local, kind: "api", baseUrl: "http://127.0.0.1:1", allowRemote: true, allowedConsumers: ["local-documents"], maxRetries: 0, timeoutMs: 1000 };
const options = { searchPaths: [docs], workspacePath: join(root,"workspace"), memoryPath: join(root,"home","memory.json"), embedding, jikji: false as const, everything: false as const, fsearch: false as const, dupey: false as const, filee: false as const, jev: false as const, webSearch: false as const, excludeExactDuplicates: false };
let agent = new AutoRAGAgent(options);
const jobs: unknown[] = []; const latencies: number[] = []; const quality: {scenario:string;query:string;expected:string;rank:number}[] = [];
async function wait(jobId: string) { let state; do { await new Promise(r=>setTimeout(r,50)); state=agent.indexJobs.status(jobId)!; } while (["queued","running","cancelling"].includes(state.state)); jobs.push(state);return state; }
async function build(profile: string) { const r=await wait(agent.startIndexJob({mode:"build",embeddingProfile:profile}).jobId);assert.equal(r.state,"succeeded",r.error); return r; }
async function query(text: string) { const start=performance.now(); const r=await agent.getRetrievalEngine().retrieveSelected(text,{methods:["local-vector"],local:true},{topK:10}); latencies.push(performance.now()-start);for(const hit of r.results){assert(isAbsolute(hit.source));assert(existsSync(hit.source));readFileSync(hit.source);}return r.results; }
const evidence: Record<string,unknown> = {model:"Qwen/Qwen3-Embedding-0.6B",dimension:1024,realConfigBefore:before,hostedApi:"SKIP: no operator fixture profile/credential supplied; loopback API protocol is tested separately",minsync:"No MinSync runtime path is used"};
try {
 const health=await fetch(`${endpoint}/health`).then(r=>r.json());evidence.health=health;
 await build("local-qwen3");
 const warm=await wait(agent.startIndexJob({mode:"refresh"}).jobId);assert.equal(warm.report?.embedded,0);assert.equal(warm.state,"succeeded");
 for(const [id,_en,_zh,enQuery,zhQuery] of topics) for(const [language,text] of [["en",enQuery],["zh",zhQuery]]) {
  const hits=await query(text);for(const target of ["en","中文"]) {const expected=`${id}-${target}.txt`;const rank=hits.findIndex(h=>h.source.endsWith(expected));quality.push({scenario:`${language}->${target}`,query:text,expected,rank:rank<0?0:rank+1});}
 }
 // Thirty-two warm queries, with both target languages evaluated independently.
 for(const [id,_en,_zh,enQuery,zhQuery] of topics) for(const [language,text] of [["en",`According to company policy, ${enQuery}`],["zh",`根据公司的规定，${zhQuery}`]]) {const hits=await query(text);for(const target of ["en","中文"]){const expected=`${id}-${target}.txt`;const rank=hits.findIndex(h=>h.source.endsWith(expected));quality.push({scenario:`${language}->${target}`,query:text,expected,rank:rank<0?0:rank+1});}}
 const pdfHits=await query("Which propellants are used by rocket launch vehicles?");assert(pdfHits.some(h=>h.source.endsWith("launch-guide.pdf")));
	await build("api-protocol-fixture");await query("Who approves refund exceptions?");
 const ready=join(options.workspacePath,".autorag","local-index","ready.json");const active=readFileSync(ready,"utf8");
 const failed=await wait(agent.startIndexJob({mode:"build",embeddingProfile:"failed-candidate"}).jobId);assert.equal(failed.state,"failed");assert.equal(readFileSync(ready,"utf8"),active);await query("退款例外需要谁批准？");
 const cancel=agent.startIndexJob({mode:"build",embeddingProfile:"local-qwen3"});agent.indexJobs.cancel(cancel.jobId);assert.equal((await wait(cancel.jobId)).state,"cancelled");assert.equal(readFileSync(ready,"utf8"),active);
 await build("local-qwen3");await agent.indexJobs.close();agent=new AutoRAGAgent(options);await query("What receipt is required for international travel reimbursement?");
 writeFileSync(join(docs,"refund-en.txt"),"Refund exceptions require director approval before payout. The finance desk checks the approval.");
 const delta=await wait(agent.startIndexJob({mode:"refresh"}).jobId);assert.equal(delta.state,"succeeded");assert.equal(delta.report?.embedded,1);
 rmSync(join(docs,"backup-en.txt"));const deletion=await wait(agent.startIndexJob({mode:"refresh"}).jobId);assert.equal(deletion.state,"succeeded");assert((deletion.report?.deleted??0)>0);
 const sorted=latencies.slice(0,32).sort((a,b)=>a-b);evidence.query={samples:32,p50Ms:sorted[15],p95Ms:sorted[30],failures:0};
 evidence.quality=Object.fromEntries([...new Set(quality.map(x=>x.scenario))].map(scenario=>{const values=quality.filter(x=>x.scenario===scenario);return [scenario,{questions:values.length,recallAt5:values.filter(x=>x.rank>0&&x.rank<=5).length/values.length,recallAt10:values.filter(x=>x.rank>0).length/values.length}];}));
 assert(quality.every(x=>x.rank>0),"All 32 bilingual target-document labels must be present within top 10");
 evidence.labels=quality;evidence.jobs=jobs;evidence.nodeMaxRssKiB=process.resourceUsage().maxRSS;evidence.result="PASS";
} finally {
 await agent.indexJobs.close();await releaseEmbedders();const after=realHash();assert.equal(after,before);evidence.realConfigAfter=after;rmSync(root,{recursive:true,force:true});evidence.cleanup="Removed only this run's synthetic fixture/home/workspace; external embedding service retained";
 const output=process.env.AUTORAG_QA_EVIDENCE;if(output){mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(evidence,null,2)+"\n");}
}
console.log(JSON.stringify({result:evidence.result,query:evidence.query,quality:evidence.quality,realConfigUnchanged:true},null,2));
