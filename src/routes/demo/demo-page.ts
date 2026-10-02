import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../db/connections";
import { conversations, leads } from "../../db/schema";
import { generateMarianaResponse } from "../../services/conversations/generateMarianaResponse";
import { leadIngestionService } from "../../services/leads/lead-ingestion";
import { SchedulingChoiceService } from "../../services/calendar/scheduling-choice-service";
import { SchedulingConfirmationOrchestrator } from "../../services/calendar/scheduling-confirmation-orchestrator";
import { SchedulingConfirmationService } from "../../services/calendar/scheduling-confirmation-service";

const choiceService = new SchedulingChoiceService();
const confirmationService = new SchedulingConfirmationService();
const confirmationOrchestrator = new SchedulingConfirmationOrchestrator();

const getDemoContext = async (sessionId: string) => {
	const phone = `demo${sessionId.replace(/\\D/g, "")}`;
	const ingestion = await leadIngestionService.ingest({ phone, source: "whatsapp" });
	let [conversation] = await db.select().from(conversations)
		.where(and(eq(conversations.leadId, ingestion.lead.id), eq(conversations.status, "active")))
		.limit(1);
	if (!conversation) {
		[conversation] = await db.insert(conversations).values({ leadId: ingestion.lead.id }).returning();
	}
	return { lead: ingestion.lead, conversation };
};

const demoPage: FastifyPluginAsync = async (app) => {
	app.post("/demo/chat", {
		schema: { body: z.object({ message: z.string().trim().min(1), sessionId: z.string().trim().min(8).max(100) }) },
	}, async (request, reply) => {
		try {
			const { message, sessionId } = request.body;
			const phone = `demo${sessionId.replace(/\\D/g, "")}`;
			const ingestion = await leadIngestionService.ingest({ phone, source: "whatsapp" });

			let [conversation] = await db.select().from(conversations)
				.where(and(eq(conversations.leadId, ingestion.lead.id), eq(conversations.status, "active")))
				.limit(1);

			if (!conversation) {
				[conversation] = await db.insert(conversations).values({ leadId: ingestion.lead.id }).returning();
			}

			const result = await generateMarianaResponse({ currentMessages: [message], leadId: ingestion.lead.id });
			const [updatedLead] = await db.select().from(leads).where(eq(leads.id, ingestion.lead.id)).limit(1);

			return reply.send({
				conversationId: conversation.id,
				lead: updatedLead,
				reply: result.result.reply,
				metadata: result.metadata,
				schedulingOffer: result.schedulingOffer ? {
					messageId: result.schedulingOffer.updatedAssistantMessage.id,
					slots: result.schedulingOffer.offeredSlots,
				} : null,
			});
		} catch (error) {
			request.log.error({ error, event: "demo_chat_failed" });
			return reply.code(500).send({ error: error instanceof Error ? error.message : "Demo chat failed" });
		}
	});
	app.get("/demo", async (_request, reply) => {
		const html = String.raw`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Mariana — Demo</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,sans-serif;background:#090b10;color:#f4f7fb;min-height:100vh}.shell{min-height:100vh;display:grid;place-items:center;padding:28px}.app{width:min(1180px,100%);display:grid;grid-template-columns:minmax(0,720px) 320px;gap:18px}.card{background:#11151d;border:1px solid #242b38;border-radius:22px;overflow:hidden;box-shadow:0 24px 80px #0008}.top{height:78px;padding:16px 20px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #242b38;background:#151a23}.avatar{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;background:#7c3aed;font-weight:800}.name{font-weight:750}.online{font-size:12px;color:#72e6a4;margin-top:2px}.chat{height:590px;padding:24px;overflow:auto;background:radial-gradient(circle at 80% 0,#211d35 0,transparent 35%),#0d1118}.msg{max-width:76%;padding:12px 15px;border-radius:17px;margin:10px 0;line-height:1.45;font-size:14px;white-space:pre-wrap}.in{background:#171d27;border:1px solid #27303d;border-top-left-radius:5px}.out{margin-left:auto;background:#6337d8;border-top-right-radius:5px}.composer{display:flex;gap:10px;padding:14px;border-top:1px solid #242b38}.composer input{flex:1;background:#0b0e14;border:1px solid #2b3442;color:#fff;border-radius:14px;padding:13px 14px;outline:none}.actions{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 14px}.actions button{border:1px solid #8b5cf6;background:#17132a;color:#fff;border-radius:12px;padding:9px 12px;cursor:pointer;font-weight:650}.actions button:disabled{opacity:.55;cursor:not-allowed}.composer button{border:0;border-radius:14px;padding:0 19px;background:#7c3aed;color:#fff;font-weight:750;cursor:pointer}.panel{padding:22px}.panel h2{margin:0 0 4px;font-size:18px}.sub{color:#8e99aa;font-size:13px;margin-bottom:20px}.row{padding:13px 0;border-bottom:1px solid #252c38}.label{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#7f8a9d}.value{margin-top:5px;font-weight:650}.progress{height:7px;background:#252c38;border-radius:10px;overflow:hidden;margin:8px 0 18px}.progress i{display:block;width:78%;height:100%;background:#8b5cf6;border-radius:10px}.badge{display:inline-flex;padding:5px 9px;border-radius:999px;background:#1d2b24;color:#73e5a3;font-size:12px;font-weight:700}@media(max-width:850px){.app{grid-template-columns:1fr}.panel{display:none}.chat{height:62vh}}
</style></head><body><div class="shell"><div class="app"><section class="card"><header class="top"><div class="avatar">M</div><div><div class="name">Mariana</div><div class="online">● Assistente de Consórcios</div></div></header><main class="chat" id="chat"><div class="msg out">Olá, quero saber sobre consórcio.</div><div class="msg in">Olá! 👋 Sou a Mariana. Vou te ajudar a encontrar uma opção de consórcio adequada. Para começar, qual é o seu nome?</div></main><form class="composer" id="form"><input id="input" autocomplete="off" placeholder="Digite uma mensagem..."/><button>Enviar</button></form></section><aside class="card panel"><h2>Mariana IA</h2><div class="sub">Demonstração comercial</div><div class="label">Qualificação</div><div class="progress"><i></i></div><div class="row"><div class="label">Lead</div><div class="value" id="lead">Aguardando nome</div></div><div class="row"><div class="label">Objetivo</div><div class="value" id="objective">—</div></div><div class="row"><div class="label">Faixa de valor</div><div class="value" id="budget">—</div></div><div class="row"><div class="label">Status</div><div class="value"><span class="badge" id="status">Em atendimento</span></div></div><div class="row"><div class="label">Agendamento</div><div class="value" id="meeting">Aguardando qualificação</div></div></aside></div></div>
<script>
const chat=document.getElementById("chat"),form=document.getElementById("form"),input=document.getElementById("input"),lead=document.getElementById("lead"),objective=document.getElementById("objective"),budget=document.getElementById("budget"),status=document.getElementById("status"),meeting=document.getElementById("meeting"),button=form.querySelector("button");
const sessionId=crypto.randomUUID();
const add=(text,kind)=>{const el=document.createElement("div");el.className="msg "+kind;el.textContent=text;chat.appendChild(el);chat.scrollTop=chat.scrollHeight};
const addActions=(buttons)=>{const wrap=document.createElement("div");wrap.className="actions";buttons.forEach(b=>{const el=document.createElement("button");el.type="button";el.textContent=b.title;el.dataset.action=b.id.split(":")[0];el.dataset.slotId=b.id.split(":").slice(1).join(":");wrap.appendChild(el)});chat.appendChild(wrap);chat.scrollTop=chat.scrollHeight;return wrap};
const updatePanel=(data)=>{const l=data.lead||{};lead.textContent=l.name&&l.name!==l.phone?l.name:"Aguardando nome";objective.textContent=l.objective||"—";budget.textContent=l.currentSituation||"—";status.textContent=l.status==="qualified"?"Qualificado":l.status==="scheduled"?"Agendado":"Em atendimento";if(data.schedulingOffer?.slots?.length){meeting.textContent=data.schedulingOffer.slots.map((s,i)=>(i+1)+". "+new Date(s.start).toLocaleString("pt-BR",{dateStyle:"short",timeStyle:"short"})).join(" • ")}};
const schedule=async(action,slotId,wrap)=>{wrap.querySelectorAll("button").forEach(b=>b.disabled=true);try{const response=await fetch("/demo/schedule",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,slotId,sessionId})});const data=await response.json();if(!response.ok)throw new Error(data.error||"Falha no agendamento");add(data.body||data.message,"in");if(data.action==="confirm"){addActions(data.buttons)}else if(data.action==="confirmed"){meeting.textContent=new Date(data.slot.startAt).toLocaleString("pt-BR",{dateStyle:"short",timeStyle:"short"})+" • "+data.slot.consultantName;status.textContent="Agendado";updatePanel(data)}else{meeting.textContent="Não confirmado"}}catch(error){add(error.message||"Não foi possível concluir o agendamento.","in")}};
chat.addEventListener("click",e=>{const target=e.target;if(!(target instanceof HTMLButtonElement)||!target.dataset.slotId)return;schedule(target.dataset.action,target.dataset.slotId,target.parentElement)});
form.addEventListener("submit",async e=>{e.preventDefault();const value=input.value.trim();if(!value||button.disabled)return;add(value,"out");input.value="";button.disabled=true;button.textContent="...";try{const response=await fetch("/demo/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:value,sessionId})});const data=await response.json();if(!response.ok)throw new Error(data.error||"Falha ao conversar com a Mariana");add(data.reply,"in");updatePanel(data);if(data.schedulingOffer?.slots?.length)addActions(data.schedulingOffer.slots.map((s,i)=>({id:s.id,title:(i+1)+". "+new Date(s.start).toLocaleString("pt-BR",{dateStyle:"short",timeStyle:"short"})}))) }catch(error){add(error.message||"Não foi possível processar a mensagem.","in")}finally{button.disabled=false;button.textContent="Enviar";input.focus()}});
</script></body></html>`;
		return reply.type("text/html; charset=utf-8").send(html);
	});
};

export default demoPage;
