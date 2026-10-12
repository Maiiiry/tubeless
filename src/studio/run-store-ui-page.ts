export const PIPELINE_RUN_STUDIO_STYLE = String.raw`
    :root {
      --ink: #171816;
      --muted: #6f716c;
      --faint: #9a9c96;
      --line: #dedfd9;
      --line-strong: #c8cac2;
      --paper: #fff;
      --ground: #f1f2ed;
      --blue: #275efe;
      --blue-soft: #eaf0ff;
      --green: #1c7c54;
      --green-soft: #e8f5ee;
      --red: #bf3b35;
      --red-soft: #fbefee;
      --amber: #9d6512;
      --amber-soft: #fbf3e3;
      --shadow: 0 1px 1px rgba(22, 24, 21, .025), 0 10px 32px rgba(22, 24, 21, .04);
      --sans: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: var(--ground); color: var(--ink); font-family: var(--sans); }
    body { min-width: 320px; }
    button, input, select, textarea { font: inherit; }
    button { color: inherit; }
    button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 2px solid #7898ff; outline-offset: 2px; }
    .shell { min-height: 100vh; display: grid; grid-template-columns: 228px minmax(0, 1fr); }
    .rail { position: sticky; top: 0; height: 100vh; padding: 24px 16px 18px; background: #1b1d1a; color: #f8f9f4; display: flex; flex-direction: column; }
    .brand { display: flex; gap: 11px; align-items: center; padding: 0 8px 26px; }
    .mark { width: 30px; height: 30px; display: grid; place-items: center; border: 1px solid #4e524a; border-radius: 8px; background: #252824; }
    .brand strong { display: block; letter-spacing: -.02em; font-size: 15px; }
    .brand small { color: #969b91; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; }
    .rail-label { margin: 14px 10px 7px; color: #73786f; font-size: 10px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    .nav { display: grid; gap: 3px; }
    .nav button { width: 100%; padding: 10px 11px; border: 0; border-radius: 7px; background: transparent; color: #aeb2aa; display: flex; align-items: center; gap: 10px; cursor: pointer; text-align: left; font-size: 13px; }
    .nav button:hover { color: #fff; background: #242723; }
    .nav button.active { color: #fff; background: #30332f; box-shadow: inset 0 0 0 1px #3d413a; }
    .nav svg { width: 16px; height: 16px; }
    .nav-count { margin-left: auto; min-width: 22px; padding: 2px 6px; border-radius: 10px; background: #3a3e37; color: #cbd0c6; font: 10px var(--mono); text-align: center; }
    .rail-foot { margin-top: auto; padding: 12px 9px 3px; border-top: 1px solid #30332e; }
    .connection { display: flex; gap: 8px; align-items: center; color: #aeb3aa; font-size: 11px; }
    .pulse { width: 7px; height: 7px; border-radius: 50%; background: #63d297; box-shadow: 0 0 0 4px rgba(99,210,151,.1); }
    .pulse.lost { background: #ff8c84; box-shadow: 0 0 0 4px rgba(255,140,132,.12); }
    .database { margin-top: 7px; overflow: hidden; text-overflow: ellipsis; color: #6f746c; font: 10px var(--mono); white-space: nowrap; }
    .workspace { width: 100%; max-width: 1760px; min-width: 0; margin: 0 auto; padding: 28px 32px 52px; }
    .topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 22px; }
    .eyebrow { margin-bottom: 5px; color: var(--faint); font-size: 10px; font-weight: 750; letter-spacing: .13em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(24px, 3vw, 36px); line-height: 1.06; letter-spacing: -.045em; font-weight: 680; }
    .lede { margin: 8px 0 0; color: var(--muted); font-size: 13px; line-height: 1.45; }
    .toolbar { display: flex; gap: 8px; align-items: center; }
    .search { width: min(290px, 30vw); padding: 9px 11px 9px 34px; border: 1px solid var(--line); border-radius: 8px; outline: none; background: var(--paper) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='none' stroke='%239a9c96' stroke-width='1.5'%3E%3Ccircle cx='7' cy='7' r='4.5'/%3E%3Cpath d='m10.5 10.5 4 4'/%3E%3C/svg%3E") no-repeat 10px center; box-shadow: 0 1px 0 rgba(0,0,0,.02); font-size: 12px; }
    .search:focus { border-color: #9db3ff; box-shadow: 0 0 0 3px var(--blue-soft); }
    .icon-button { width: 36px; height: 36px; border: 1px solid var(--line); border-radius: 8px; background: var(--paper); cursor: pointer; display: grid; place-items: center; }
    .icon-button:hover { border-color: var(--line-strong); }
    .icon-button.spinning svg { animation: spin .65s linear infinite; }
    .primary-button { height: 36px; padding: 0 13px; border: 1px solid #174ce2; border-radius: 8px; background: var(--blue); color: #fff; cursor: pointer; box-shadow: 0 1px 1px rgba(18,54,156,.18); font-size: 11px; font-weight: 700; }
    .primary-button:hover { background: #174fe8; }
    .primary-button:disabled { opacity: .55; cursor: wait; }
    .secondary-button { padding: 8px 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--paper); color: var(--ink); cursor: pointer; font-size: 10px; font-weight: 700; white-space: nowrap; }
    .secondary-button:hover { border-color: var(--line-strong); background: #fafbf8; }
    .danger-button { height: 36px; padding: 0 12px; border: 1px solid #e4c6c3; border-radius: 8px; background: #fffafa; color: #a53c36; cursor: pointer; font-size: 11px; font-weight: 700; }
    .danger-button:hover { border-color: #d8a9a5; background: var(--red-soft); }
    .danger-button:disabled { opacity: .45; cursor: not-allowed; }
    .danger-button svg { width: 13px; height: 13px; margin-right: 5px; vertical-align: -2px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 16px; }
    .metric { padding: 14px 15px 13px; border: 1px solid var(--line); background: rgba(255,255,255,.78); border-radius: 9px; box-shadow: 0 1px 0 rgba(255,255,255,.8); }
    .metric-label { color: var(--muted); font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .metric-value { margin-top: 8px; font: 600 24px/1 var(--mono); letter-spacing: -.05em; }
    .metric-note { margin-top: 6px; color: var(--faint); font-size: 10px; }
    .sheet { border: 1px solid var(--line); border-radius: 11px; background: var(--paper); box-shadow: var(--shadow); overflow: hidden; }
    .sheet-head { min-height: 54px; padding: 12px 15px; border-bottom: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .sheet-title { font-size: 13px; font-weight: 700; letter-spacing: -.01em; }
    .sheet-subtitle { color: var(--faint); font-size: 10px; }
    .content-grid { display: grid; grid-template-columns: minmax(340px, .78fr) minmax(500px, 1.22fr); gap: 14px; align-items: start; }
    .run-list { max-height: calc(100vh - 263px); overflow: auto; }
    .run-group { position: sticky; top: 0; z-index: 2; padding: 8px 15px; border-bottom: 1px solid #e7e8e2; background: rgba(248,249,245,.96); color: var(--faint); font-size: 9px; font-weight: 750; letter-spacing: .1em; text-transform: uppercase; backdrop-filter: blur(5px); }
    .run-row { width: 100%; padding: 14px 15px; border: 0; border-bottom: 1px solid #ecece7; background: #fff; cursor: pointer; text-align: left; display: grid; gap: 8px; }
    .run-row:last-child { border-bottom: 0; }
    .run-row:hover { background: #fafbf8; }
    .run-row.running:not(.selected) { background: #f9faff; }
    .run-row.selected { background: #f5f7ff; box-shadow: inset 3px 0 var(--blue); }
    .run-primary, .run-secondary, .detail-heading, .step-head { display: flex; align-items: center; gap: 9px; }
    .run-primary strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: 13px; white-space: nowrap; }
    .run-time { margin-left: auto; color: var(--faint); font: 10px var(--mono); }
    .run-secondary { color: var(--muted); font-size: 10px; }
    .run-secondary code { min-width: 0; overflow: hidden; text-overflow: ellipsis; font: 10px var(--mono); white-space: nowrap; }
    .run-activity { min-width: 0; padding: 8px 9px; border-radius: 6px; background: var(--blue-soft); color: #3153b8; display: flex; gap: 8px; align-items: center; font-size: 9px; }
    .run-activity strong { white-space: nowrap; }
    .run-activity span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .run-parentage { margin: 0 0 12px; display: flex; align-items: center; flex-wrap: wrap; gap: 6px; color: var(--faint); font-size: 9px; }
    .run-parentage button { padding: 0; border: 0; background: none; color: #4165cf; cursor: pointer; font: 9px var(--mono); }
    .nested-runs { margin-bottom: 17px; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
    .nested-run { width: 100%; padding: 9px 11px; border: 0; border-bottom: 1px solid #e9eae4; background: #fbfcf9; cursor: pointer; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 8px; text-align: left; }
    .nested-run:last-child { border-bottom: 0; }
    .nested-run:hover { background: #f5f7ff; }
    .nested-run strong { overflow: hidden; text-overflow: ellipsis; font-size: 10px; white-space: nowrap; }
    .nested-run small { color: var(--faint); font: 9px var(--mono); }
    .dot { width: 4px; height: 4px; border-radius: 50%; background: var(--line-strong); }
    .status { display: inline-flex; align-items: center; gap: 5px; padding: 3px 7px; border-radius: 999px; font-size: 9px; font-weight: 750; letter-spacing: .06em; text-transform: uppercase; white-space: nowrap; }
    .status-mark { width: 9px; height: 9px; display: inline-grid; place-items: center; font: 800 10px/1 var(--sans); letter-spacing: 0; }
    .status.completed { color: var(--green); background: var(--green-soft); }
    .status.failed, .status.cancelled { color: var(--red); background: var(--red-soft); }
    .status.running { color: var(--blue); background: var(--blue-soft); }
    .status.running .status-mark { border: 1.5px solid #b9c9fa; border-top-color: currentColor; border-radius: 50%; animation: spin .8s linear infinite; font-size: 0; }
    .status.skipped, .status.planned { color: var(--amber); background: var(--amber-soft); }
    .detail { min-height: 460px; }
    .detail-body { padding: 18px; }
    .detail-heading { align-items: flex-start; }
    .detail-heading-copy { min-width: 0; }
    .detail-heading-actions { margin-left: auto; display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 8px; }
    .detail-heading-actions .icon-button { flex: 0 0 36px; }
    .unavailable-run { min-height: 330px; padding: 38px 24px; display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 10px; }
    .unavailable-run strong { font-size: 13px; }
    .unavailable-run p { max-width: 380px; margin: 0; color: var(--muted); font-size: 11px; line-height: 1.55; }
    .unavailable-run code { max-width: 100%; color: var(--faint); font: 10px var(--mono); overflow-wrap: anywhere; }
    .detail-heading h2 { min-width: 0; margin: 0; overflow: hidden; text-overflow: ellipsis; font-size: 19px; letter-spacing: -.03em; white-space: nowrap; }
    .detail-heading .status { margin-top: 2px; }
    .detail-kicker { margin-bottom: 5px; color: var(--faint); font-size: 9px; font-weight: 750; letter-spacing: .09em; text-transform: uppercase; }
    .run-id { margin-top: 6px; color: var(--faint); font: 10px var(--mono); overflow-wrap: anywhere; }
    .detail-meta { margin: 15px 0 18px; display: grid; grid-template-columns: 1.35fr repeat(3, minmax(0, 1fr)); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
    .detail-meta > div { min-width: 0; padding: 10px 11px; border-right: 1px solid var(--line); }
    .detail-meta > div:last-child { border-right: 0; }
    .detail-meta label { display: block; margin-bottom: 5px; color: var(--faint); font-size: 9px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; }
    .detail-meta span { display: block; overflow: hidden; text-overflow: ellipsis; font: 11px var(--mono); white-space: nowrap; }
    .section-title { margin: 18px 0 8px; display: flex; align-items: center; justify-content: space-between; color: var(--muted); font-size: 10px; font-weight: 750; letter-spacing: .1em; text-transform: uppercase; }
    .step-list { border: 1px solid var(--line); border-radius: 9px; overflow: hidden; }
    .step { position: relative; padding: 12px 13px 12px 43px; border-bottom: 1px solid #e9eae4; }
    .step:last-child { border-bottom: 0; }
    .step:not(:last-child)::after { content: ""; position: absolute; top: 31px; bottom: -7px; left: 22px; width: 1px; background: var(--line); }
    .step-status-icon { position: absolute; top: 13px; left: 13px; z-index: 1; width: 19px; height: 19px; border: 1px solid var(--line); border-radius: 5px; background: #f7f8f5; color: var(--faint); display: grid; place-items: center; }
    .step-status-icon svg { width: 11px; height: 11px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 2; }
    .step-status-icon.completed { border-color: #bddfce; background: var(--green-soft); color: var(--green); }
    .step-status-icon.running { border-color: #cad6fa; background: var(--blue-soft); color: var(--blue); }
    .step-status-icon.running i { width: 10px; height: 10px; border: 2px solid #bdcaf1; border-top-color: currentColor; border-radius: 50%; animation: spin .8s linear infinite; }
    .step-status-icon.skipped { border-color: #ead5ac; background: var(--amber-soft); color: var(--amber); }
    .step-status-icon.cancelled { border-color: #dfcfcd; background: #f7f1f0; color: #8f5d58; }
    .step-status-icon.failed { border-color: #efcbc8; background: var(--red-soft); color: var(--red); font-size: 11px; font-weight: 800; }
    .step-status-icon.planned { font-size: 12px; line-height: 1; }
    .step-head strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: 12px; white-space: nowrap; }
    .step-head code { color: var(--faint); font: 9px var(--mono); }
    .step-duration { margin-left: auto; color: var(--muted); font: 10px var(--mono); }
    .step-description { margin-top: 4px; color: var(--muted); font-size: 10px; line-height: 1.45; }
    .execution { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 5px; }
    .artifact-filter { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 10px; font-size: 11px; color: var(--muted); }
    .artifact-filter select { max-width: 100%; padding: 4px 6px; border: 1px solid var(--line); border-radius: 5px; background: white; }
    .artifact-detail { margin-top: 8px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; font-size: 12px; overflow-wrap: anywhere; }
    .artifact-detail summary { cursor: pointer; }
    .artifact-info { margin-top: 8px; font-size: 11px; line-height: 1.7; color: var(--muted); }
    .artifact-note { color: var(--faint); margin: 6px 0; }
    .artifact-receipt { margin-top: 8px; font-size: 11px; color: var(--muted); }
    .artifact-detail pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 10px/1.6 var(--mono); }
    .execution-summary { padding: 4px 6px; border: 1px solid var(--line); border-radius: 5px; color: var(--muted); background: #fbfbf8; font: 9px var(--mono); }
    .execution-summary b { color: var(--faint); font: 700 8px var(--sans); letter-spacing: .06em; text-transform: uppercase; }
    .progress { height: 3px; margin-top: 10px; overflow: hidden; border-radius: 2px; background: #e7e9e2; }
    .progress > i { display: block; height: 100%; width: 0; background: var(--blue); transition: width .3s ease; }
    .progress > i.w0{width:0%}.progress > i.w1{width:1%}.progress > i.w2{width:2%}.progress > i.w3{width:3%}.progress > i.w4{width:4%}.progress > i.w5{width:5%}.progress > i.w6{width:6%}.progress > i.w7{width:7%}.progress > i.w8{width:8%}.progress > i.w9{width:9%}.progress > i.w10{width:10%}.progress > i.w11{width:11%}.progress > i.w12{width:12%}.progress > i.w13{width:13%}.progress > i.w14{width:14%}.progress > i.w15{width:15%}.progress > i.w16{width:16%}.progress > i.w17{width:17%}.progress > i.w18{width:18%}.progress > i.w19{width:19%}.progress > i.w20{width:20%}.progress > i.w21{width:21%}.progress > i.w22{width:22%}.progress > i.w23{width:23%}.progress > i.w24{width:24%}.progress > i.w25{width:25%}.progress > i.w26{width:26%}.progress > i.w27{width:27%}.progress > i.w28{width:28%}.progress > i.w29{width:29%}.progress > i.w30{width:30%}.progress > i.w31{width:31%}.progress > i.w32{width:32%}.progress > i.w33{width:33%}.progress > i.w34{width:34%}.progress > i.w35{width:35%}.progress > i.w36{width:36%}.progress > i.w37{width:37%}.progress > i.w38{width:38%}.progress > i.w39{width:39%}.progress > i.w40{width:40%}.progress > i.w41{width:41%}.progress > i.w42{width:42%}.progress > i.w43{width:43%}.progress > i.w44{width:44%}.progress > i.w45{width:45%}.progress > i.w46{width:46%}.progress > i.w47{width:47%}.progress > i.w48{width:48%}.progress > i.w49{width:49%}.progress > i.w50{width:50%}.progress > i.w51{width:51%}.progress > i.w52{width:52%}.progress > i.w53{width:53%}.progress > i.w54{width:54%}.progress > i.w55{width:55%}.progress > i.w56{width:56%}.progress > i.w57{width:57%}.progress > i.w58{width:58%}.progress > i.w59{width:59%}.progress > i.w60{width:60%}.progress > i.w61{width:61%}.progress > i.w62{width:62%}.progress > i.w63{width:63%}.progress > i.w64{width:64%}.progress > i.w65{width:65%}.progress > i.w66{width:66%}.progress > i.w67{width:67%}.progress > i.w68{width:68%}.progress > i.w69{width:69%}.progress > i.w70{width:70%}.progress > i.w71{width:71%}.progress > i.w72{width:72%}.progress > i.w73{width:73%}.progress > i.w74{width:74%}.progress > i.w75{width:75%}.progress > i.w76{width:76%}.progress > i.w77{width:77%}.progress > i.w78{width:78%}.progress > i.w79{width:79%}.progress > i.w80{width:80%}.progress > i.w81{width:81%}.progress > i.w82{width:82%}.progress > i.w83{width:83%}.progress > i.w84{width:84%}.progress > i.w85{width:85%}.progress > i.w86{width:86%}.progress > i.w87{width:87%}.progress > i.w88{width:88%}.progress > i.w89{width:89%}.progress > i.w90{width:90%}.progress > i.w91{width:91%}.progress > i.w92{width:92%}.progress > i.w93{width:93%}.progress > i.w94{width:94%}.progress > i.w95{width:95%}.progress > i.w96{width:96%}.progress > i.w97{width:97%}.progress > i.w98{width:98%}.progress > i.w99{width:99%}.progress > i.w100{width:100%}
    .progress-copy { margin-top: 5px; color: var(--faint); font-size: 9px; }
    .step .plan-nested { margin-top: 8px; }
    .progress-details { margin-top: 8px; display: grid; gap: 3px; }
    .progress-detail { min-width: 0; display: flex; align-items: baseline; gap: 6px; color: var(--muted); font: 9px/1.4 var(--mono); }
    .progress-detail b { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 650; }
    .progress-detail span { color: var(--faint); }
    .progress-detail.completed { color: var(--green); }
    .progress-detail.failed { color: var(--red); }
    .progress-detail.running { color: var(--blue); }
    .progress-detail.pending, .progress-detail.skipped { color: var(--amber); }
    .progress-detail-truncated { color: var(--faint); font: 9px/1.4 var(--mono); }
    .error-card { padding: 12px; border: 1px solid #efcbc8; border-radius: 8px; background: #fff8f7; }
    .error-code { color: var(--red); font: 10px var(--mono); }
    .error-message { margin-top: 6px; font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
    .debug-group { margin-top: 12px; padding-top: 11px; border-top: 1px solid #efcbc8; font-size: 11px; }
    .debug-group > strong { display: block; margin-bottom: 7px; font-size: 10px; }
    .debug-issues { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; }
    .debug-issues li { display: flex; flex-wrap: wrap; gap: 4px 9px; line-height: 1.45; overflow-wrap: anywhere; }
    .debug-issues code { color: var(--red); font: 10px var(--mono); overflow-wrap: anywhere; }
    .debug-cause { padding: 7px 0; border-top: 1px solid #efcbc8; overflow-wrap: anywhere; }
    .debug-cause:first-child { border-top: 0; }
    .debug-cause summary { cursor: pointer; font-size: 10px; line-height: 1.5; }
    .debug-cause-body { margin: 7px 0 0 15px; color: var(--muted); font: 10px/1.5 var(--mono); }
    .debug-note { margin-top: 7px; color: var(--muted); font-size: 10px; }
    .log-filters { display: grid; grid-template-columns: minmax(130px, 1fr) minmax(90px, auto) minmax(110px, auto); gap: 8px; margin-bottom: 8px; }
    .log-filters label { min-width: 0; display: grid; gap: 4px; color: var(--muted); font-size: 9px; }
    .log-filters input, .log-filters select { min-width: 0; width: 100%; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--paper); color: var(--ink); font-size: 10px; }
    .log-empty { padding: 12px; border: 1px solid var(--line); border-radius: 8px; color: var(--muted); font-size: 10px; }
    .logs { border: 1px solid var(--line); border-radius: 8px; background: #20221f; color: #dfe3da; overflow: auto; max-height: 220px; }
    .log-line { display: grid; grid-template-columns: 70px 42px minmax(0, 1fr); gap: 8px; padding: 7px 9px; border-bottom: 1px solid #30332e; font: 9px/1.45 var(--mono); }
    .log-line:last-child { border-bottom: 0; }
    .log-time { color: #777d72; }
    .log-level { color: #8fb0ff; text-transform: uppercase; }
    .log-level.error { color: #ff8c84; }
    .log-level.warn { color: #e8bd72; }
    .log-message { overflow-wrap: anywhere; }
    @media (max-width: 900px) { .log-filters { grid-template-columns: 1fr 1fr; } .log-filters label:first-child { grid-column: 1 / -1; } }
    .empty { min-height: 330px; padding: 38px; display: grid; place-items: center; text-align: center; color: var(--muted); }
    .empty-icon { width: 44px; height: 44px; margin: 0 auto 13px; display: grid; place-items: center; border: 1px solid var(--line); border-radius: 12px; background: #fafbf8; }
    .empty strong { display: block; color: var(--ink); font-size: 13px; }
    .empty p { max-width: 300px; margin: 7px auto 0; font-size: 11px; line-height: 1.55; }
    .catalog { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; padding: 14px; }
    .catalog-card { min-height: 150px; padding: 15px; border: 1px solid var(--line); border-radius: 9px; background: #fbfcf9; display: flex; flex-direction: column; }
    .catalog-card h3 { margin: 0; font-size: 13px; letter-spacing: -.015em; }
    .catalog-card p { margin: 8px 0 14px; color: var(--muted); font-size: 10px; line-height: 1.55; }
    .catalog-actions { margin-top: auto; display: flex; gap: 7px; }
    .modal-backdrop { position: fixed; inset: 0; z-index: 50; padding: 22px; display: grid; place-items: center; background: rgba(22,24,21,.42); backdrop-filter: blur(3px); }
    .modal { width: min(720px, 100%); max-height: calc(100vh - 44px); overflow: auto; border: 1px solid #cfd1ca; border-radius: 13px; background: var(--paper); box-shadow: 0 24px 80px rgba(16,18,15,.22); }
    .confirm-modal { width: min(460px, 100%); }
    .confirm-body { padding: 18px 20px 20px; }
    .confirm-copy { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
    .confirm-warning { margin: 14px 0 0; padding: 10px 11px; border: 1px solid #efcbc8; border-radius: 8px; background: #fff8f7; color: #87413c; font-size: 10px; line-height: 1.5; }
    .confirm-actions { margin-top: 18px; display: flex; justify-content: flex-end; gap: 8px; }
    .modal-head { position: sticky; top: 0; z-index: 3; padding: 18px 20px 16px; border-bottom: 1px solid var(--line); background: rgba(255,255,255,.97); display: flex; justify-content: space-between; gap: 18px; backdrop-filter: blur(8px); }
    .modal-head h2 { margin: 0; font-size: 18px; letter-spacing: -.03em; }
    .modal-head p { margin: 6px 0 0; color: var(--muted); font-size: 11px; line-height: 1.5; }
    .close-button { width: 30px; height: 30px; flex: 0 0 auto; border: 1px solid var(--line); border-radius: 7px; background: #fafbf8; cursor: pointer; font-size: 16px; }
    .launch-form { padding: 18px 20px 20px; }
    .parameter-fields { margin: 4px 0 18px; display: grid; gap: 18px; }
    .form-section { min-width: 0; }
    .form-section + .form-section { padding-top: 16px; border-top: 1px solid var(--line); }
    .form-section-head { margin-bottom: 10px; display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
    .form-section-head strong { font-size: 11px; letter-spacing: -.01em; }
    .form-section-head span { color: var(--faint); font-size: 9px; }
    .parameter-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 13px; }
    .field { display: grid; gap: 7px; margin-bottom: 15px; }
    .field label { color: var(--muted); font-size: 10px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
    .parameter-grid .field { min-width: 0; margin: 0; }
    .field select, .field textarea, .field input:not([type="checkbox"]) { width: 100%; border: 1px solid var(--line-strong); border-radius: 8px; outline: none; background: #fff; }
    .field select, .field input:not([type="checkbox"]) { height: 38px; padding: 0 10px; font-size: 12px; }
    .field select[multiple] { height: 104px; padding: 6px; }
    .field textarea { min-height: 82px; padding: 10px 11px; resize: vertical; font: 11px/1.55 var(--mono); }
    .field select:focus, .field textarea:focus, .field input:focus { border-color: #8ba7ff; box-shadow: 0 0 0 3px var(--blue-soft); }
    .field-hint { color: var(--faint); font-size: 9px; line-height: 1.5; }
    .boolean-field { min-height: 72px; padding: 11px 12px; border: 1px solid var(--line); border-radius: 8px; background: #fbfcf9; display: flex; align-items: flex-start; gap: 9px; cursor: pointer; transition: border-color .15s ease, background .15s ease; }
    .boolean-field:hover { border-color: var(--line-strong); background: #f8f9f5; }
    .boolean-field input { width: 15px; height: 15px; margin: 1px 0 0 auto; accent-color: var(--blue); }
    .boolean-field strong { display: block; font: 650 10px var(--mono); color: var(--ink); }
    .boolean-field small { display: block; margin-top: 5px; color: var(--muted); font-size: 9px; line-height: 1.4; }
    .required-mark { margin-left: 5px; color: var(--red); font-size: 8px; }
    .advanced { margin: 0 0 14px; border-top: 1px solid var(--line); padding-top: 11px; }
    .advanced summary { color: var(--muted); cursor: pointer; font-size: 10px; font-weight: 700; }
    .advanced .field { margin: 11px 0 0; }
    .command-help { max-height: 190px; margin: 10px 0 0; padding: 11px 12px; overflow: auto; border: 1px solid #dedfd9; border-radius: 8px; background: #f6f7f3; color: #555952; white-space: pre-wrap; font: 9px/1.5 var(--mono); }
    .plan-result { min-height: 110px; max-height: 340px; margin: 2px 0 15px; border: 1px solid #ccd6f2; border-radius: 9px; overflow: auto; }
    .plan-placeholder { padding: 28px; color: var(--faint); font-size: 10px; text-align: center; }
    .plan-summary { padding: 10px 12px; border-bottom: 1px solid var(--line); background: #f8f9f5; display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 10px; }
    .plan-selection-mode { padding: 10px 12px; border-bottom: 1px solid #dce3f5; background: #f5f7ff; display: grid; gap: 3px; font-size: 9px; line-height: 1.45; }
    .plan-selection-mode strong { color: #3153b8; font-size: 10px; }
    .plan-selection-mode span { color: #536185; }
    .plan-steps { display: grid; }
    .plan-step { padding: 10px 12px; border-bottom: 1px solid #e9eae4; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px 12px; }
    .plan-step:last-child { border-bottom: 0; }
    .plan-step-title { min-width: 0; display: flex; align-items: center; gap: 7px; }
    .plan-step-title strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: 10px; white-space: nowrap; }
    .plan-step-id { color: var(--faint); font: 9px var(--mono); overflow-wrap: anywhere; }
    .plan-kind { padding: 2px 5px; border: 1px solid var(--line); border-radius: 999px; color: var(--faint); background: #fff; font-size: 7px; font-weight: 750; letter-spacing: .06em; text-transform: uppercase; white-space: nowrap; }
    .plan-kind.pipeline { border-color: #cad6fa; color: #3153b8; background: var(--blue-soft); }
    .plan-step > small { color: var(--faint); font-size: 9px; line-height: 1.4; }
    .plan-explanation { grid-column: 1 / -1; margin: 2px 0 0; padding: 0; list-style: none; display: grid; gap: 5px; }
    .plan-explanation li { display: grid; grid-template-columns: 90px minmax(0, 1fr); gap: 8px; color: var(--muted); font-size: 9px; line-height: 1.45; }
    .plan-explanation li strong { color: var(--ink); font-weight: 700; }
    .plan-references { display: inline-flex; flex-wrap: wrap; gap: 4px 7px; }
    .plan-references > span { min-width: 0; overflow-wrap: anywhere; }
    .plan-references code { font: 9px var(--mono); color: #3153b8; overflow-wrap: anywhere; }
    .plan-nested { grid-column: 1 / -1; padding: 8px 9px; border-radius: 6px; background: #f5f7ff; color: #4660ad; display: flex; align-items: center; flex-wrap: wrap; gap: 5px; font-size: 8px; }
    .plan-nested strong { margin-right: 3px; font: 650 9px var(--mono); }
    .plan-nested code { padding: 2px 4px; border: 1px solid #d8def2; border-radius: 4px; background: #fff; font: 8px var(--mono); }
    .plan-disposition { grid-row: 1 / span 2; grid-column: 2; align-self: center; padding: 3px 6px; border-radius: 999px; color: var(--green); background: var(--green-soft); font-size: 8px; font-weight: 750; letter-spacing: .05em; text-transform: uppercase; }
    .plan-disposition.skipped { color: var(--amber); background: var(--amber-soft); }
    .launch-error { margin-bottom: 15px; padding: 10px 11px; border: 1px solid #efcbc8; border-radius: 8px; background: #fff8f7; color: var(--red); font-size: 10px; line-height: 1.5; white-space: pre-wrap; }
    .modal-actions { position: sticky; bottom: 0; z-index: 2; margin: 0 -20px -20px; padding: 13px 20px 14px; border-top: 1px solid var(--line); background: rgba(255,255,255,.97); display: flex; justify-content: flex-end; gap: 8px; backdrop-filter: blur(8px); }
    .secondary-button { height: 36px; padding: 0 13px; border: 1px solid var(--line); border-radius: 8px; background: #fff; cursor: pointer; font-size: 11px; font-weight: 650; }
    .toast { position: fixed; right: 22px; bottom: 22px; z-index: 60; max-width: min(420px, calc(100vw - 44px)); padding: 11px 13px; border: 1px solid #bdd8c9; border-radius: 9px; background: #f4fff8; color: #176a47; box-shadow: var(--shadow); font-size: 11px; }
    .hidden { display: none !important; }
    @media (max-width: 980px) {
      .shell { grid-template-columns: 74px minmax(0, 1fr); }
      .rail { padding-inline: 10px; }
      .brand { justify-content: center; padding-inline: 0; }
      .brand-copy, .rail-label, .nav span:not(.nav-count), .rail-foot { display: none; }
      .nav button { justify-content: center; padding: 11px 6px; }
      .nav-count { display: none; }
      .content-grid { grid-template-columns: 1fr; }
      .run-list { max-height: 360px; }
    }
    @media (max-width: 680px) {
      .shell { display: block; }
      .rail { position: sticky; z-index: 10; width: 100%; height: 58px; padding: 8px 12px; flex-direction: row; align-items: center; }
      .brand { padding: 0 8px 0 0; }
      .nav { margin-left: auto; display: flex; }
      .nav button { width: 42px; }
      .workspace { padding: 20px 14px 36px; }
      .topbar { display: block; }
      .toolbar { margin-top: 15px; }
      .search { width: 100%; }
      #clearHistoryButton { width: 36px; padding: 0; font-size: 0; }
      #clearHistoryButton svg { margin: 0; }
      .metrics { grid-template-columns: repeat(2, 1fr); }
      .content-grid { display: block; }
      .detail { margin-top: 12px; }
      .detail-meta { grid-template-columns: repeat(2, 1fr); }
      .detail-meta > div:nth-child(2) { border-right: 0; }
      .detail-meta > div:nth-child(-n+2) { border-bottom: 1px solid var(--line); }
      .parameter-grid { grid-template-columns: 1fr; }
    }
    .definition-history { margin-bottom: 20px; }
    .definition-body { padding: 18px; display: grid; gap: 12px; }
    .definition-body select { max-width: 100%; }
    .definition-identity,    .definition-changes { overflow-wrap: anywhere; font-size: 12px; }
    .definition-changes li { margin-bottom: 10px; }
    .section-title-actions { display: inline-flex; align-items: center; gap: 10px; }
    .view-toggle { display: inline-flex; padding: 2px; border: 1px solid var(--line); border-radius: 7px; background: var(--paper); }
    .view-toggle button { padding: 3px 8px; border: 0; border-radius: 5px; background: none; color: var(--muted); cursor: pointer; font-size: 9px; font-weight: 750; letter-spacing: .06em; text-transform: uppercase; }
    .view-toggle button[aria-pressed="true"] { background: var(--ink); color: #fff; }
    .graph-panel { border: 1px solid var(--line); border-radius: 9px; overflow: hidden; background: #fbfcf9; }
    .graph-canvas { max-height: 640px; padding: 6px; overflow: auto; background-image: radial-gradient(circle, #e2e3dd 1px, transparent 1.2px); background-size: 16px 16px; }
    .graph-canvas svg { display: block; margin: 0 auto; overflow: visible; }
    .graph-hit, .graph-edge-group, .graph-badge, .graph-run-header { cursor: pointer; outline: none; }
    .graph-node { animation: graph-enter .35s ease-out both; }
    .graph-disc { fill: #f7f8f5; stroke: var(--line-strong); stroke-width: 1.5; transform-box: fill-box; transform-origin: center; transition: fill .3s ease, stroke .3s ease; }
    .graph-ring { fill: none; stroke: currentColor; stroke-width: 1.2; opacity: .45; }
    .graph-halo { fill: currentColor; opacity: 0; transform-box: fill-box; transform-origin: center; }
    .graph-focus { fill: none; stroke: transparent; stroke-width: 2; }
    .graph-hit:hover .graph-disc { stroke-width: 2.4; }
    .graph-hit:focus-visible .graph-focus { stroke: var(--blue); stroke-dasharray: 3 3; }
    .graph-node.selected .graph-focus { stroke: var(--blue); }
    .graph-spinner { display: none; fill: none; stroke: var(--blue); stroke-width: 3; stroke-linecap: round; transform-box: fill-box; transform-origin: center; }
    .graph-icon { fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
    .graph-label { fill: var(--ink); font: 600 10px var(--sans); text-anchor: middle; pointer-events: none; }
    .graph-node { color: var(--faint); }
    .graph-node.planned .graph-disc { stroke-dasharray: 3 3; }
    .graph-node.planned .graph-label { fill: var(--muted); font-weight: 500; }
    .graph-node.running { color: var(--blue); }
    .graph-node.running .graph-disc { fill: var(--blue-soft); stroke: #cad6fa; }
    .graph-node.running .graph-spinner { display: inline; animation: graph-spin 1.4s linear infinite, graph-arc 1.4s ease-in-out infinite; }
    .graph-node.running .graph-halo { animation: graph-breathe 1.8s ease-out infinite; }
    .graph-node.completed { color: var(--green); }
    .graph-node.completed .graph-disc { fill: var(--green-soft); stroke: var(--green); }
    .graph-node.failed { color: var(--red); }
    .graph-node.failed .graph-disc { fill: var(--red-soft); stroke: var(--red); }
    .graph-node.cancelled { color: var(--amber); }
    .graph-node.cancelled .graph-disc { fill: var(--amber-soft); stroke: var(--amber); }
    .graph-node.cancelled .graph-icon { fill: currentColor; stroke-width: 1; }
    .graph-node.skipped { color: #8b8e86; }
    .graph-node.skipped .graph-disc { fill: #f1f2ed; stroke: #b9bcb3; stroke-dasharray: 2 2; }
    .graph-node.skipped .graph-label { fill: var(--muted); }
    .graph-node.pulse .graph-icon { stroke-dasharray: 20; animation: graph-draw .45s .1s ease-out both; }
    .graph-node.pulse .graph-disc { animation: graph-pop .5s cubic-bezier(.3, 1.6, .5, 1); }
    .graph-node.pulse .graph-halo { animation: graph-ripple .9s ease-out; }
    .graph-node.failed.pulse .graph-hit { animation: graph-shake .4s ease-in-out; }
    .graph-badge circle { fill: var(--ink); stroke: #fff; stroke-width: 1.5; transition: fill .2s ease; }
    .graph-badge.expanded circle, .graph-badge:hover circle { fill: var(--blue); }
    .graph-badge:focus-visible circle { stroke: var(--blue); stroke-width: 2.5; }
    .graph-badge text { fill: #fff; font: 800 7px var(--sans); text-anchor: middle; pointer-events: none; }
    .graph-edge-group { color: var(--line-strong); transition: color .4s ease; animation: graph-enter .35s ease-out both; }
    .graph-edge { fill: none; stroke: currentColor; stroke-width: 1.6; transition: stroke-width .2s ease; }
    .graph-edge-head { fill: currentColor; }
    .graph-edge-hit { fill: none; stroke: transparent; stroke-width: 12; }
    .graph-edge-flow { fill: none; stroke: var(--blue); stroke-width: 2.6; stroke-linecap: round; stroke-dasharray: 1 11; animation: graph-flow .7s linear infinite; }
    .graph-edge-group:hover .graph-edge, .graph-edge-group:focus-visible .graph-edge, .graph-edge-group.selected .graph-edge { stroke-width: 3; }
    .graph-edge-group.selected { filter: drop-shadow(0 0 3px rgba(39, 94, 254, .35)); }
    .graph-edge-group.candidate .graph-edge { stroke-dasharray: 5 4; }
    .graph-edge-group.candidate { color: #b4b7ae; }
    .graph-edge-group.active { color: #a9bdf7; }
    .graph-edge-group.active .graph-edge-head { fill: var(--blue); }
    .graph-edge-group.used { color: #8cc5a8; }
    .graph-edge-group.blocked { color: #e0aaa5; }
    .graph-edge-group.blocked .graph-edge { stroke-dasharray: 2 3; }
    .graph-edge-group.unused { color: var(--line); }
    .graph-edge-group.optional .graph-edge { stroke-width: 1.2; }
    .graph-edge-group.gate .graph-edge { stroke-dasharray: 1 4; stroke-linecap: round; stroke-width: 1.8; }
    .graph-edge-group.gate.settled, .graph-edge-group.gate.candidate { color: #d9c7a3; }
    .graph-edge-group.gate.tripped { color: var(--red); }
    .graph-frame { fill: rgba(255, 255, 255, .7); stroke: var(--line-strong); stroke-dasharray: 3 3; animation: graph-enter .3s ease-out both; }
    .graph-run-frame { fill: #fff; stroke: var(--line-strong); }
    .graph-run-frame.running { stroke: #a9bdf7; }
    .graph-run-frame.completed { stroke: #8cc5a8; }
    .graph-run-frame.failed { stroke: #e0aaa5; }
    .graph-run-frame.cancelled { stroke: #e2c58f; }
    .graph-run-frame.selected { stroke: var(--blue); stroke-width: 2; }
    .graph-run-header rect { fill: #f4f5f1; }
    .graph-run-header:focus-visible rect, .graph-run-header:hover rect { fill: var(--blue-soft); }
    .graph-run-header text { fill: var(--muted); font: 600 9px var(--mono); }
    .graph-sequence { fill: none; stroke: var(--line-strong); stroke-dasharray: 2 3; }
    .graph-more { fill: var(--muted); font: 9px var(--mono); text-anchor: middle; }
    .graph-inspector { padding: 14px 15px; border-top: 1px solid var(--line); background: var(--paper); display: grid; gap: 10px; }
    .graph-inspector h3 { margin: 0; overflow-wrap: anywhere; font: 650 13px var(--mono); }
    .graph-inspector .status { justify-self: start; }
    .graph-kicker { color: var(--muted); font-size: 9px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
    .graph-hint { margin: 0; color: var(--muted); font-size: 11px; line-height: 1.5; }
    .graph-facts { margin: 0; display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 5px 14px; font-size: 11px; }
    .graph-facts dt { color: var(--muted); }
    .graph-facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; font-family: var(--mono); }
    .graph-io h4 { margin: 4px 0 6px; color: var(--muted); font-size: 9px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
    .graph-io > button { width: 100%; margin-bottom: 4px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 7px; background: #fbfcf9; cursor: pointer; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 8px; text-align: left; }
    .graph-io > button:hover { border-color: var(--line-strong); }
    .graph-io code { overflow: hidden; text-overflow: ellipsis; font: 10px var(--mono); white-space: nowrap; }
    .graph-io small { color: var(--faint); font-size: 9px; }
    .graph-edge-state { margin: 0; padding: 7px 9px; border-radius: 7px; background: #f4f5f1; font-size: 11px; }
    .graph-edge-state.active { background: var(--blue-soft); color: var(--blue); }
    .graph-edge-state.used, .graph-edge-state.settled { background: var(--green-soft); color: var(--green); }
    .graph-edge-state.blocked, .graph-edge-state.tripped { background: var(--red-soft); color: var(--red); }
    .graph-edge-state.candidate { background: var(--amber-soft); color: var(--amber); }
    .graph-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .graph-actions .primary-button { height: 30px; font-size: 10px; }
    .graph-legend { padding: 9px 15px; border-top: 1px solid var(--line); display: flex; flex-wrap: wrap; gap: 6px 14px; color: var(--muted); font-size: 9px; }
    .graph-legend span { display: inline-flex; align-items: center; gap: 5px; }
    .graph-legend i { width: 9px; height: 9px; border: 1.5px solid var(--line-strong); border-radius: 50%; background: #f7f8f5; }
    .graph-legend i.running { border-color: var(--blue); border-top-color: #cad6fa; background: var(--blue-soft); }
    .graph-legend i.completed { border-color: var(--green); background: var(--green-soft); }
    .graph-legend i.failed { border-color: var(--red); background: var(--red-soft); }
    .graph-legend i.cancelled { border-color: var(--amber); background: var(--amber-soft); }
    .graph-legend i.skipped { border-style: dotted; background: #f1f2ed; }
    .graph-legend i.planned { border-style: dashed; }
    .graph-legend i.run { box-shadow: inset 0 0 0 2px #fff, inset 0 0 0 3px var(--line-strong); }
    .graph-legend b { width: 16px; height: 0; border-top: 2px solid #8cc5a8; }
    .graph-legend b.candidate { border-top: 2px dashed #b4b7ae; }
    .graph-legend b.gate { border-top: 2px dotted #d9a5a0; }
    @keyframes graph-enter { from { opacity: 0; } }
    @keyframes graph-spin { to { transform: rotate(360deg); } }
    @keyframes graph-arc { 0% { stroke-dasharray: 8 92; stroke-dashoffset: 0; } 50% { stroke-dasharray: 55 45; stroke-dashoffset: -15; } 100% { stroke-dasharray: 8 92; stroke-dashoffset: -100; } }
    @keyframes graph-breathe { 0% { opacity: .22; transform: scale(.7); } 100% { opacity: 0; transform: scale(1.25); } }
    @keyframes graph-ripple { 0% { opacity: .45; transform: scale(.7); } 100% { opacity: 0; transform: scale(1.7); } }
    @keyframes graph-pop { 0% { transform: scale(.82); } 60% { transform: scale(1.1); } 100% { transform: scale(1); } }
    @keyframes graph-draw { from { stroke-dashoffset: 20; } to { stroke-dashoffset: 0; } }
    @keyframes graph-shake { 0%, 100% { transform: translateX(0); } 25% { transform: translateX(-3px); } 75% { transform: translateX(3px); } }
    @keyframes graph-flow { from { stroke-dashoffset: 24; } to { stroke-dashoffset: 0; } }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; }
    }
  `;

export interface StudioPage {
  readonly csp: string;
  html(mount: string): string;
}

async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function studioDocument(script: string): string {
  return (
    String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light" />
  <title>Tubeless — Studio</title>
  <style>` +
    PIPELINE_RUN_STUDIO_STYLE +
    String.raw`</style>
</head>
<body>
  <div id="studio-root"></div>
  <script type="module">` +
    script +
    String.raw`</script>
</body>
</html>`
  );
}

/** Build the page from the compiled client. Only a validated, nonsecret mount enters the HTML. */
export async function createStudioPage(script: string): Promise<StudioPage> {
  const styleHash = await sha256Base64(PIPELINE_RUN_STUDIO_STYLE);
  const scriptHash = await sha256Base64(script);
  const csp = `default-src 'none'; style-src 'sha256-${styleHash}'; script-src 'sha256-${scriptHash}'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  const document = studioDocument(script);
  return {
    csp,
    html(mount) {
      const escaped = mount
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
      return document.replace(
        '<meta charset="utf-8" />',
        '<meta charset="utf-8" /><meta name="tubeless-studio-mount" content="' + escaped + '" />'
      );
    },
  };
}
