(() => {
  const milestones = [
    ["overview","Overview"],
    ["product-definition","1. Product Definition"],
    ["staff-ux","2. R&R Staff UX"],
    ["brand-book","3. Brand Book"],
    ["design-system","4. Design Guide"],
    ["prototype","5. Interactive Prototype"],
    ["architecture","6. Case Core Architecture"],
    ["working-case-core","7. Working Case Core"],
    ["glass-identification","8. Glass Identification"],
    ["sourcing-pricing","9. Sourcing + Pricing"],
    ["quote-approval","10. Quote / Approval"],
    ["ordering","11. Ordering"],
    ["installation-closeout","12. Installation + Closeout"],
    ["end-to-end","13. Full End-to-End"],
    ["launch-readiness","14. Launch Readiness"]
  ];

  const state = {
    persona: "staff",
    caseStage: 0,
    caseCreated: false,
    selectedOffer: 1,
    quoteApproved: false,
    orderPlaced: false,
    installScheduled: false,
    installCompleted: false,
    checks: JSON.parse(localStorage.getItem("rrLaunchChecks") || "{}"),
    cases: JSON.parse(localStorage.getItem("rrDemoCases") || "[]"),
    theme: localStorage.getItem("rrTheme") || "dark"
  };

  const applyTheme = () => {
    document.documentElement.dataset.theme = state.theme;
    document.documentElement.style.colorScheme = state.theme;
    localStorage.setItem("rrTheme", state.theme);
  };
  applyTheme();

  const stageNames = ["Intake","Identify","Source","Price","Quote","Order","Install","Closeout"];
  const fmtMoney = n => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(n);
  const esc = s => String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
  const save = () => {
    localStorage.setItem("rrDemoCases", JSON.stringify(state.cases));
    localStorage.setItem("rrLaunchChecks", JSON.stringify(state.checks));
  };

  function route(){
    return location.hash.replace(/^#\/?/,"") || "overview";
  }
  function nav(){
    return milestones.map(([id,label],i)=>`<a href="#/${id}" class="${route()===id?"active":""}"><span class="num">${id==="overview"?"•":i}</span><span>${label}</span></a>`).join("");
  }
  function shell(body,title){
    return `
      <div class="shell">
        <aside class="sidebar">
          <div class="brand"><div class="mark">R&R</div><div><h1>Finest Auto Glass</h1><p>Client milestone demo suite</p></div></div>
          <div class="nav-title">Milestones</div><nav class="nav">${nav()}</nav>
        </aside>
        <main class="main">
          <div class="topbar"><div class="crumb">R&R / Client Demo / ${esc(title)}</div><div class="top-actions"><button class="btn small ghost" data-action="toggle-theme" aria-label="Toggle color theme">${state.theme==="dark"?"☀ Light mode":"☾ Dark mode"}</button><button class="btn small ghost" data-action="reset-demo">Reset demo</button><a class="btn small" href="#/overview">Milestone map</a></div></div>
          <div class="content">${body}${footer()}</div>
        </main>
      </div>`;
  }
  function footer(){
    const idx = milestones.findIndex(([id])=>id===route());
    const prev = idx>0?milestones[idx-1]:null;
    const next = idx<milestones.length-1?milestones[idx+1]:null;
    return `<div class="route-footer">
      <div>${prev?`<a class="btn ghost" href="#/${prev[0]}">← ${prev[1]}</a>`:""}</div>
      <div>${next?`<a class="btn primary" href="#/${next[0]}">${next[1]} →</a>`:""}</div>
    </div>`;
  }
  function hero(kicker,title,lead,badges=""){
    return `<section class="hero"><div class="hero-card"><div class="kicker">${kicker}</div><h2>${title}</h2><p class="lead">${lead}</p><div class="meta">${badges}</div></div><div class="metric-grid"><div class="metric"><span>Mode</span><strong>Demo</strong></div><div class="metric"><span>Backend</span><strong>None</strong></div><div class="metric"><span>Routing</span><strong>Client</strong></div><div class="metric"><span>State</span><strong>Local</strong></div></div></section>`;
  }
  function stages(current=state.caseStage){
    return `<div class="stage-strip">${stageNames.map((s,i)=>`<div class="stage ${i<current?"done":i===current?"current":""}">${i+1}. ${s}</div>`).join("")}</div>`;
  }
  function overview(){
    const cards = milestones.slice(1).map(([id,label],i)=>`<a class="card" href="#/${id}" style="text-decoration:none"><div class="kicker">Milestone ${i+1}</div><h3>${label.replace(/^\d+\. /,"")}</h3><p>${[
      "Define what we are building and why.","Show how R&R staff work in the system.","Make the R&R identity visible and concrete.","Turn the brand into reusable interface rules.","Click through the channel experiences.","Show the technical shape behind the product.","Create and inspect simulated cases.","Demonstrate YMM-first glass identification.","Compare supplier offers and pricing.","Show channel-specific quote approval.","Simulate safe procurement.","Schedule, complete, and close the job.","Walk one case through the full lifecycle.","Show what production readiness means."
    ][i]}</p><span class="badge brand">Open demo →</span></a>`).join("");
    return shell(
      hero("Client presentation","R&R Product Milestone Demo Suite","A single, no-backend, routed demo experience for walking the client from product definition through launch readiness.",'<span class="badge success">14 milestones</span><span class="badge brand">Interactive</span><span class="badge">Client-side only</span>')+
      `<section class="section"><div class="section-head"><div><h3>Milestone map</h3><p>Use this as the presentation sequence with the client.</p></div></div><div class="grid three">${cards}</div></section>`,
      "Overview"
    );
  }
  function productDefinition(){
    return shell(hero("Milestone 1","Product Definition v0.1","Show the client exactly what the team believes the first operational product must do.",'<span class="badge success">Internally accepted</span><span class="badge attn">Client validation pending</span>')+
      `<div class="grid two">
        <div class="panel"><h3>Desired outcome</h3><div class="callout">Every R&R glass job has one canonical Case with a current workflow state and a durable event history.</div><div class="section"><h4>Required inputs</h4><div class="meta"><span class="badge">Channel</span><span class="badge">Year</span><span class="badge">Make</span><span class="badge">Model</span><span class="badge">VIN</span><span class="badge">Glass type</span></div></div></div>
        <div class="panel"><h3>Working assumptions to validate</h3><div class="checklist">
          ${["RRA-000123 case format","REQUEST_RECEIVED initial state","Separate Customer entity","Separate Vehicle entity","Separate Glass Request","Append-only business events"].map(x=>`<div class="check"><span class="badge attn">Assumption</span><span>${x}</span></div>`).join("")}
        </div></div>
      </div>
      <section class="section"><h3>Business boundaries</h3><div class="grid three"><div class="card"><h4>One operational truth</h4><p>One Case powers every channel experience.</p></div><div class="card"><h4>Actions drive state</h4><p>The UI never arbitrarily patches workflow state.</p></div><div class="card"><h4>No paid VIN lookup here</h4><p>Case Core is the spine, not the identification engine.</p></div></div></section>`,
      "Product Definition"
    );
  }
  function staffUX(){
    return shell(hero("Milestone 2","R&R Staff UX v0.1","Show how an employee creates, finds, and follows a job without exposing implementation complexity.",'<span class="badge success">Internally accepted</span><span class="badge">Responsive</span>')+
      `<section class="section"><div class="grid two">
        <div class="panel"><h3>Case Queue</h3><div class="table-wrap"><table class="table"><thead><tr><th>Case</th><th>Vehicle</th><th>Glass</th><th>Status</th></tr></thead><tbody>
          <tr><td>RRA-000123</td><td>2018 Jeep Wrangler</td><td>Windshield</td><td><span class="badge attn">Awaiting approval</span></td></tr>
          <tr><td>RRA-000124</td><td>2021 Toyota Camry</td><td>Door Glass</td><td><span class="badge brand">Sourcing</span></td></tr>
          <tr><td>RRA-000125</td><td>2020 Honda CR-V</td><td>Windshield</td><td><span class="badge success">Scheduled</span></td></tr>
        </tbody></table></div></div>
        <div class="panel"><h3>Case Detail</h3><div class="meta"><span class="badge">DIRECT</span><span class="badge brand">Request received</span><span class="badge mono">REQUEST_RECEIVED</span></div><h4 style="margin-top:18px">2018 Jeep Wrangler · Windshield</h4><p>VIN 1C4HJXEG3JW224862</p>${stages(0)}<div class="section"><h4>Current action</h4><div class="card"><p>No staff action required at this step.</p></div></div></div>
      </div></section>
      <section class="section"><div class="panel"><h3>Activity</h3><div class="timeline"><div class="event"><div class="dot-col"><div class="dot"></div></div><div class="event-body"><strong>Case created</strong><small>Today · Staff</small></div></div></div></div></section>`,
      "R&R Staff UX"
    );
  }
  function brandBook(){
    const swatches=[["#0B1220","Primary dark"],["#4F46E5","Brand indigo"],["#059669","Success"],["#D97706","Attention"],["#DC2626","Critical"],["#64748B","Neutral"]];
    return shell(hero("Milestone 3","Brand Book v0.1","Make R&R's identity tangible: dependable, direct, capable, responsive, and human.",'<span class="badge success">Internally accepted</span><span class="badge attn">Client brand validation pending</span>')+
      `<section class="section"><div class="section-head"><div><h3>Brand personality</h3><p>What the product should feel like.</p></div></div><div class="grid four">${["Dependable","Direct","Capable","Responsive"].map((x,i)=>`<div class="card"><div class="kicker">0${i+1}</div><h3>${x}</h3><p>${["Steady, trustworthy and accountable.","Plain language, minimal jargon.","Operationally sharp and credible.","Work should feel like it is moving."][i]}</p></div>`).join("")}</div></section>
      <section class="section"><h3>Color direction</h3><div class="palette">${swatches.map(([c,n])=>`<div class="swatch" style="background:${c}"><span>${n}<br>${c}</span></div>`).join("")}</div></section>
      <section class="section"><div class="grid two"><div class="panel"><h3>Voice</h3><div class="callout">“We know the work, we keep the job moving, and we make the process easy to understand.”</div><p><strong>Prefer:</strong> Your quote is ready.</p><p><strong>Avoid:</strong> Your request has advanced into downstream procurement orchestration.</p></div><div class="panel"><h3>Channel expression</h3><div class="checklist"><div class="check"><span class="badge">Staff</span>Precise + operational</div><div class="check"><span class="badge">Direct</span>Simple + reassuring</div><div class="check"><span class="badge">Auction</span>Compact + batch-friendly</div><div class="check"><span class="badge">Insurance</span>Formal + authorization-aware</div></div></div></div></section>`,
      "Brand Book"
    );
  }
  function designSystem(){
    return shell(hero("Milestone 4","Design Guide / Design System v0.1","Show the client how the brand becomes reusable components, states, layouts, and interaction patterns.",'<span class="badge success">Internally accepted</span><span class="badge">Token-driven</span>')+
      `<section class="section"><div class="grid two">
        <div class="panel"><h3>Component board</h3><div class="btn-row"><button class="btn primary">Primary action</button><button class="btn">Secondary</button><button class="btn ghost">Ghost</button></div><div class="spacer"></div><div class="meta"><span class="badge success">Completed</span><span class="badge brand">In progress</span><span class="badge attn">Needs approval</span><span class="badge critical">Blocked</span></div><div class="field"><label>VIN</label><input value="1C4HJXEG3JW224862" /></div><div class="field"><label>Glass type</label><select><option>Windshield</option><option>Back Glass</option><option>Door Glass</option></select></div></div>
        <div class="panel"><h3>Typography</h3><div class="type-sample"><span class="tiny muted">2XL / Bold</span><div style="font-size:32px;font-weight:800">Case RRA-000123</div></div><div class="type-sample"><span class="tiny muted">LG / Semibold</span><div style="font-size:20px;font-weight:650">Current workflow state</div></div><div class="type-sample"><span class="tiny muted">MD / Regular</span><div>2018 Jeep Wrangler · Windshield</div></div><div class="type-sample"><span class="tiny muted">SM / Metadata</span><div class="muted">Updated 4 minutes ago</div></div></div>
      </div></section>
      <section class="section"><h3>Workflow stage pattern</h3><div class="panel">${stages(4)}</div></section>
      <section class="section"><div class="grid two"><div class="card"><h3>R&R Staff</h3><p>Dark, dense, operational.</p></div><div class="card light"><h3>Direct Customer</h3><p>Light, simple, reassuring.</p><button class="btn primary">Approve quote</button></div></div></section>`,
      "Design Guide"
    );
  }
  function prototype(){
    const tabs=["staff","direct","auction","insurance"];
    const content = {
      staff:`<div class="panel"><div class="kicker">R&R Staff</div><h3>Case RRA-000123</h3><p>2018 Jeep Wrangler · Windshield</p>${stages(4)}<div class="grid two section"><div class="card"><h4>Selected glass</h4><p>DW02416 GTY · FYG</p><div class="price">$92.25</div></div><div class="card"><h4>Current action</h4><p>Quote v1 ready for customer approval.</p><button class="btn primary">Send quote</button></div></div></div>`,
      direct:`<div class="customer-shell"><div class="kicker">Your auto glass service</div><h2 style="color:#111827">Your quote is ready</h2><p>2018 Jeep Wrangler · Windshield replacement</p><div class="card light"><span class="muted tiny">Total</span><div class="price">$389.69</div><p>Includes glass, installation, and applicable tax.</p><div class="btn-row"><button class="btn primary">Approve quote</button><button class="btn ghost">Decline</button></div></div></div>`,
      auction:`<div class="panel"><div class="kicker">America's Auto Auction</div><h3>Open vehicles</h3><div class="table-wrap"><table class="table"><thead><tr><th>Vehicle</th><th>Stock #</th><th>Glass</th><th>Status</th><th>Action</th></tr></thead><tbody><tr><td>2019 Chevy Silverado</td><td>AA-49182</td><td>Windshield</td><td>Needs approval</td><td><button class="btn small primary">Review $374.69</button></td></tr><tr><td>2021 Toyota Camry</td><td>AA-49197</td><td>Door Glass</td><td>Scheduled</td><td>Sep 28</td></tr></tbody></table></div></div>`,
      insurance:`<div class="panel"><div class="kicker">Insurance Assignment</div><h3>Assignment #SF-882701</h3><p>Jordan M. · 2020 Honda CR-V · Windshield</p><div class="meta"><span class="badge attn">Awaiting authorization</span><span class="badge">Claim #CLM-291844</span></div><div class="card section"><h4>Estimate ready</h4><p>Waiting for carrier authorization before scheduling.</p><button class="btn primary">Submit estimate</button></div></div>`
    };
    return shell(hero("Milestone 5","Interactive Product Prototype","Switch personas to show how one underlying job becomes a different experience for each channel.",'<span class="badge success">Available for client review</span><span class="badge">No backend</span>')+
      `<section class="section"><div class="persona-tabs">${tabs.map(t=>`<button class="btn ${state.persona===t?"active":""}" data-persona="${t}">${t[0].toUpperCase()+t.slice(1)}</button>`).join("")}</div><div id="persona-demo">${content[state.persona]}</div></section>`,
      "Interactive Prototype"
    );
  }
  function architecture(){
    return shell(hero("Milestone 6","Case Core Architecture v0.1","Explain the technical foundation without requiring the client to read implementation details.",'<span class="badge attn">Next technical milestone</span>')+
      `<section class="section"><div class="panel"><h3>One Case, many experiences</h3><div class="arch"><div class="arch-box"><strong>Channels</strong><p>Staff · Direct · Auction · Insurance</p></div><div class="arrow">→</div><div class="arch-box"><strong>Case Core</strong><p>Identity · State · Vehicle · Glass Request · Events</p></div></div></div></section>
      <section class="section"><div class="grid three"><div class="card"><h4>Canonical Case</h4><p>One job record, regardless of channel.</p></div><div class="card"><h4>Append-only events</h4><p>History explains what happened without destructive rewrites.</p></div><div class="card"><h4>Action-driven state</h4><p>Business actions advance the workflow, not arbitrary UI patches.</p></div></div></section>
      <section class="section"><div class="panel"><h3>Conceptual contract</h3><pre class="mono tiny">Case
├─ id
├─ reference
├─ channel
├─ currentState
├─ customer
├─ vehicle
├─ glassRequest
└─ events[]</pre></div></section>`,
      "Case Core Architecture"
    );
  }
  function workingCaseCore(){
    const rows = state.cases.length ? state.cases.map(c=>`<tr><td>${esc(c.ref)}</td><td>${esc(c.year+" "+c.make+" "+c.model)}</td><td>${esc(c.glass)}</td><td><span class="badge brand">Request received</span></td></tr>`).join("") : '<tr><td colspan="4" class="muted">No locally-created demo cases yet.</td></tr>';
    return shell(hero("Milestone 7","Working Case Core","Create a fake Case entirely in the browser and watch it appear in the queue.",'<span class="badge">Client-state simulation</span><span class="badge">localStorage</span>')+
      `<section class="section"><div class="grid two"><form class="panel" id="case-form"><h3>Create demo Case</h3><div class="field"><label>Channel</label><select name="channel"><option>DIRECT</option><option>AUCTION</option><option>INSURANCE</option></select></div><div class="grid two"><div class="field"><label>Year</label><input name="year" value="2018" required></div><div class="field"><label>Make</label><input name="make" value="Jeep" required></div></div><div class="field"><label>Model</label><input name="model" value="Wrangler" required></div><div class="field"><label>VIN</label><input name="vin" value="1C4HJXEG3JW224862" required></div><div class="field"><label>Glass type</label><select name="glass"><option>Windshield</option><option>Back Glass</option><option>Door Glass</option></select></div><button class="btn primary" type="submit">Create Case</button></form>
        <div class="panel"><h3>Case Queue</h3><div class="table-wrap"><table class="table"><thead><tr><th>Case</th><th>Vehicle</th><th>Glass</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div></div></div></section>`,
      "Working Case Core"
    );
  }
  function identification(){
    return shell(hero("Milestone 8","Glass Identification","Demonstrate YMM-first lookup and show exactly when a paid VIN lookup is justified.",'<span class="badge">Simulated rules</span><span class="badge success">$0 paid lookups by default</span>')+
      `<section class="section"><div class="grid two"><div class="panel"><h3>Request</h3><div class="field"><label>Vehicle</label><input value="2018 Jeep Wrangler"></div><div class="field"><label>Glass</label><select id="glass-choice"><option>Windshield</option><option>Door Glass</option><option>Back Glass</option></select></div><button class="btn primary" data-action="run-identification">Run identification</button><div id="ident-result" class="section"></div></div>
      <div class="panel"><h3>Decision rules</h3><div class="timeline"><div class="event"><div class="dot-col"><div class="dot"></div><div class="line"></div></div><div class="event-body"><strong>1. Search YMM first</strong><small>No VIN cost.</small></div></div><div class="event"><div class="dot-col"><div class="dot"></div><div class="line"></div></div><div class="event-body"><strong>2. Evaluate ambiguity</strong><small>One match → use it. Multiple equivalent fits → source them.</small></div></div><div class="event"><div class="dot-col"><div class="dot"></div></div><div class="event-body"><strong>3. VIN only if required</strong><small>Windshield/back glass ambiguity only. Never Door/Quarter/Vent.</small></div></div></div></div></div></section>`,
      "Glass Identification"
    );
  }
  function sourcingPricing(){
    const offers=[{name:"Primary supplier",part:"DW02415 GTY MOP",price:274.50,eligible:true},{name:"Interchangeable",part:"DW02416 GTY FYG",price:92.25,eligible:true},{name:"Regional",part:"DW02416 GTY",price:81.00,eligible:false}];
    return shell(hero("Milestone 9","Sourcing + Pricing","Compare eligible offers, exclude Regional, and demonstrate the margin-driven selection.",'<span class="badge">Simulated supplier data</span><span class="badge">No live MyGrant</span>')+
      `<section class="section"><div class="grid two"><div class="panel"><h3>Supplier offers</h3>${offers.map((o,i)=>`<div class="offer ${state.selectedOffer===i?"selected":""}" data-offer="${i}"><div><strong>${o.name}</strong><div class="tiny muted">${o.part} · ${o.eligible?"Eligible":"Excluded: Regional"}</div></div><div><strong>${fmtMoney(o.price)}</strong></div></div>`).join("")}</div>
      <div class="panel"><h3>Pricing preview</h3>${(()=>{const o=offers[state.selectedOffer]; const labor=125, target=250; const subtotal=o.price+labor+target; return `<div class="grid two"><div class="card"><span class="tiny muted">Glass cost</span><div class="price">${fmtMoney(o.price)}</div></div><div class="card"><span class="tiny muted">Labor</span><div class="price">${fmtMoney(labor)}</div></div><div class="card"><span class="tiny muted">Target profit</span><div class="price">${fmtMoney(target)}</div></div><div class="card"><span class="tiny muted">Illustrative pre-tax sell</span><div class="price">${fmtMoney(subtotal)}</div></div></div>`})()}<p class="tiny muted">Illustrative only. Final pricing/tax rules remain client-validated business logic.</p></div></div></section>`,
      "Sourcing + Pricing"
    );
  }
  function quoteApproval(){
    const status = state.quoteApproved ? '<span class="badge success">Approved</span>' : '<span class="badge attn">Awaiting approval</span>';
    return shell(hero("Milestone 10","Quote / Approval","Show the same commercial decision using channel-appropriate language.",status)+
      `<section class="section"><div class="status-map"><div class="head">Internal state</div><div class="head">Staff</div><div class="head">Direct</div><div class="head">Auction</div><div class="head">Insurance</div><div>AWAITING_APPROVAL</div><div>Awaiting Approval</div><div>Your quote is ready</div><div>Needs approval</div><div>Awaiting authorization</div></div></section>
      <section class="section"><div class="customer-shell"><div class="kicker">Direct Customer</div><h2 style="color:#111827">Windshield replacement</h2><p>2018 Jeep Wrangler · Quote v1 · Valid for 72 hours</p><div class="card light"><span class="muted tiny">Total</span><div class="price">$389.69</div><p>Includes glass, installation, and applicable tax.</p><div class="btn-row"><button class="btn primary" data-action="approve-quote" ${state.quoteApproved?"disabled":""}>${state.quoteApproved?"Quote approved":"Approve quote"}</button><button class="btn ghost">Decline</button></div></div></div></section>`,
      "Quote / Approval"
    );
  }
  function ordering(){
    return shell(hero("Milestone 11","Ordering","Demonstrate the safety gate between customer approval and a real purchase.",state.orderPlaced?'<span class="badge success">Demo order placed</span>':'<span class="badge attn">R&R confirmation required</span>')+
      `<section class="section"><div class="grid two"><div class="panel"><h3>Procurement checklist</h3><div class="checklist"><div class="check"><span class="badge success">✓</span>Quote approved</div><div class="check"><span class="badge success">✓</span>Saved glass result reused</div><div class="check"><span class="badge success">✓</span>Inventory rechecked</div><div class="check"><span class="badge attn">!</span>Human purchase confirmation</div></div></div><div class="panel"><h3>Selected order</h3><p>DW02416 GTY · FYG</p><div class="price">$92.25</div><p>Randolph · In stock</p><button class="btn primary" data-action="place-order" ${state.orderPlaced?"disabled":""}>${state.orderPlaced?"Order placed":"Confirm & place order"}</button></div></div></section>`,
      "Ordering"
    );
  }
  function installation(){
    return shell(hero("Milestone 12","Installation + Closeout","Simulate scheduling, completion, invoice readiness, and the final operational record.",state.installCompleted?'<span class="badge success">Completed</span>':state.installScheduled?'<span class="badge brand">Scheduled</span>':'<span class="badge attn">Scheduling required</span>')+
      `<section class="section"><div class="grid two"><div class="panel"><h3>Installation</h3><p>Case RRA-000123 · 2018 Jeep Wrangler</p><div class="btn-row"><button class="btn primary" data-action="schedule-install" ${state.installScheduled?"disabled":""}>${state.installScheduled?"Scheduled Sep 28":"Schedule Sep 28"}</button><button class="btn success" data-action="complete-install" ${!state.installScheduled||state.installCompleted?"disabled":""}>${state.installCompleted?"Installation completed":"Mark completed"}</button></div></div><div class="panel"><h3>Closeout</h3><div class="checklist"><div class="check"><span class="badge ${state.installCompleted?"success":""}">${state.installCompleted?"✓":"…"}</span>Installation completed</div><div class="check"><span class="badge ${state.installCompleted?"success":""}">${state.installCompleted?"✓":"…"}</span>Final invoice ready</div><div class="check"><span class="badge ${state.installCompleted?"success":""}">${state.installCompleted?"✓":"…"}</span>Job profit recorded</div></div></div></div></section>`,
      "Installation + Closeout"
    );
  }
  function endToEnd(){
    return shell(hero("Milestone 13","Full End-to-End Workflow","Walk one simulated case across all eight stages without any backend dependencies.",'<span class="badge">Client-side workflow simulator</span>')+
      `<section class="section"><div class="panel">${stages(state.caseStage)}<div class="section"><div class="grid two"><div><div class="kicker">Current stage</div><h3>${stageNames[state.caseStage]}</h3><p>${["Request captured and validated.","Glass candidates identified.","Eligible supplier offers compared.","Price reviewed and approved.","Quote awaiting/receiving approval.","Inventory rechecked and order confirmed.","Appointment scheduled and installation performed.","Invoice/profit recorded and job completed."][state.caseStage]}</p></div><div class="card"><h4>Simulator controls</h4><div class="btn-row"><button class="btn ghost" data-action="prev-stage" ${state.caseStage===0?"disabled":""}>← Previous</button><button class="btn primary" data-action="next-stage" ${state.caseStage===7?"disabled":""}>Next stage →</button></div></div></div></div></div></section>
      <section class="section"><div class="panel"><h3>What integration/E2E will prove later</h3><div class="grid three"><div class="card"><h4>Happy paths</h4><p>All allowed transitions succeed.</p></div><div class="card"><h4>Forbidden paths</h4><p>Illegal transitions stay blocked.</p></div><div class="card"><h4>Persona projections</h4><p>Each channel sees the right status and actions.</p></div></div></div></section>`,
      "Full End-to-End Workflow"
    );
  }
  function launchReadiness(){
    const items=["Production environment","Managed PostgreSQL","Secrets management","Database migrations","CI/CD","Logging & monitoring","Backups","Rollback path","Security review","Launch checklist","Operational handoff"];
    const done=items.filter(x=>state.checks[x]).length;
    const pct=Math.round(done/items.length*100);
    return shell(hero("Milestone 14","Production Deployment / Launch Readiness","Show the client what must be true before this moves from demo software into real operations.",`<span class="badge ${pct===100?"success":"attn"}">${pct}% ready</span>`)+
      `<section class="section"><div class="grid two"><div class="panel"><h3>Readiness checklist</h3><div class="checklist">${items.map(x=>`<label class="check"><input type="checkbox" data-check="${x}" ${state.checks[x]?"checked":""}><span>${x}</span></label>`).join("")}</div></div><div class="panel"><h3>Readiness score</h3><div class="price">${pct}%</div><div class="progress"><span style="width:${pct}%"></span></div><p>${done} of ${items.length} launch concerns acknowledged in this demo.</p><div class="callout">This screen is illustrative. Real readiness requires evidence from CI, infrastructure, security, backup/restore, and operational testing.</div></div></div></section>`,
      "Launch Readiness"
    );
  }

  const renderers = {
    overview, "product-definition":productDefinition, "staff-ux":staffUX, "brand-book":brandBook,
    "design-system":designSystem, prototype, architecture, "working-case-core":workingCaseCore,
    "glass-identification":identification, "sourcing-pricing":sourcingPricing, "quote-approval":quoteApproval,
    ordering, "installation-closeout":installation, "end-to-end":endToEnd, "launch-readiness":launchReadiness
  };

  function render(){
    const r=route();
    document.getElementById("app").innerHTML=(renderers[r]||overview)();
    bind();
    window.scrollTo({top:0,behavior:"instant"});
  }
  function toast(msg){
    const t=document.createElement("div"); t.className="toast"; t.textContent=msg; document.body.appendChild(t); setTimeout(()=>t.remove(),1800);
  }
  function bind(){
    document.querySelectorAll("[data-persona]").forEach(el=>el.onclick=()=>{state.persona=el.dataset.persona;render()});
    document.querySelectorAll("[data-offer]").forEach(el=>el.onclick=()=>{const i=Number(el.dataset.offer); if(i===2){toast("Regional is excluded by the working sourcing rule.");return;} state.selectedOffer=i;render()});
    const form=document.getElementById("case-form"); if(form) form.onsubmit=e=>{e.preventDefault();const fd=new FormData(form); const ref="RRA-"+String(126+state.cases.length).padStart(6,"0"); state.cases.unshift({ref,channel:fd.get("channel"),year:fd.get("year"),make:fd.get("make"),model:fd.get("model"),vin:fd.get("vin"),glass:fd.get("glass")});save();toast("Demo Case created: "+ref);render()};
    document.querySelectorAll("[data-check]").forEach(el=>el.onchange=()=>{state.checks[el.dataset.check]=el.checked;save();render()});
    document.querySelectorAll("[data-action]").forEach(el=>el.onclick=()=>{
      switch(el.dataset.action){
        case "toggle-theme": state.theme=state.theme==="dark"?"light":"dark";applyTheme();render();break;
        case "reset-demo": state.persona="staff";state.caseStage=0;state.selectedOffer=1;state.quoteApproved=false;state.orderPlaced=false;state.installScheduled=false;state.installCompleted=false;state.cases=[];state.checks={};save();toast("Demo state reset.");render();break;
        case "approve-quote": state.quoteApproved=true;toast("Quote approved in local demo state.");render();break;
        case "place-order": state.orderPlaced=true;toast("Demo order placed.");render();break;
        case "schedule-install": state.installScheduled=true;toast("Installation scheduled.");render();break;
        case "complete-install": state.installCompleted=true;toast("Installation completed.");render();break;
        case "next-stage": state.caseStage=Math.min(7,state.caseStage+1);render();break;
        case "prev-stage": state.caseStage=Math.max(0,state.caseStage-1);render();break;
        case "run-identification": {
          const glass=document.getElementById("glass-choice").value;
          const box=document.getElementById("ident-result");
          if(glass==="Door Glass") box.innerHTML='<div class="card"><span class="badge success">YMM only</span><h4>Door Glass never requires VIN</h4><p>Multiple results would route to human review if necessary.</p></div>';
          else box.innerHTML='<div class="card"><span class="badge attn">Ambiguity found</span><h4>VIN lookup may be justified</h4><p>Because this is '+glass+', a saved paid VIN lookup may be used only if YMM/options remain ambiguous.</p></div>';
          break;
        }
      }
    });
  }
  addEventListener("hashchange",render);
  render();
})();