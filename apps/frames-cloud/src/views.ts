import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { Dataset, Entity, RecentActivity, Source } from "./types";

// `html` tag can return a Promise when interpolating async values; widen
// our render-function return type so TS strict mode (Vercel) is happy.
type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

const FONT_LINK = raw(`
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
`);

const STYLE = raw(`
  :root {
    --bg: #FFFFFF;
    --bg-soft: #FAFAFA;
    --ink: #0A0A0A;
    --ink-2: #303030;
    --muted: #6B6B6B;
    --border: #E0E0E0;
    --border-soft: #F0F0F0;
    --row-hover: #FAFAFA;
    --link: #0F3CB7;
    --code-bg: #0A0A0A;
    --code-ink: #E5E5E5;

    --sans: 'Geist', 'SF Pro Display', system-ui, -apple-system, 'Helvetica Neue', sans-serif;
    --mono: 'Geist Mono', 'SF Mono', 'JetBrains Mono', ui-monospace, monospace;

    --gutter: clamp(16px, 4vw, 24px);
    --maxw: 1280px;

    --t: 120ms ease;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0B0B0C;
      --bg-soft: #131315;
      --ink: #F2F2F2;
      --ink-2: #C9C9C9;
      --muted: #8A8A8A;
      --border: #262628;
      --border-soft: #1A1A1C;
      --row-hover: #131315;
      --link: #8AB4FF;
      --code-bg: #060607;
      --code-ink: #E5E5E5;
    }
  }

  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    background: var(--bg); color: var(--ink);
    font-family: var(--sans); font-size: 14px; line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    font-feature-settings: 'tnum' on, 'cv11' on;
    text-rendering: optimizeLegibility;
  }
  ::selection { background: var(--ink); color: var(--bg); }

  :focus-visible {
    outline: 2px solid var(--ink);
    outline-offset: 2px;
    border-radius: 1px;
  }

  a {
    color: var(--ink); text-decoration: underline; text-underline-offset: 2px;
    text-decoration-thickness: 1px; text-decoration-color: var(--border);
    transition: color var(--t), text-decoration-color var(--t);
  }
  a:hover { text-decoration-color: var(--ink); }
  a.plain { text-decoration: none; }
  a.plain:hover {
    text-decoration: underline; text-underline-offset: 2px;
    text-decoration-thickness: 1px; text-decoration-color: var(--ink);
  }

  img, svg { max-width: 100%; display: block; }

  /* Header — single hairline */
  header.site {
    border-bottom: 1px solid var(--border);
    background: var(--bg);
    position: sticky; top: 0; z-index: 10;
  }
  header.site .row {
    max-width: var(--maxw); margin: 0 auto; padding: 14px var(--gutter);
    display: flex; align-items: center; justify-content: space-between;
    gap: 16px; font-size: 12.5px;
  }
  header.site .brand {
    font-family: var(--mono); color: var(--ink); text-transform: uppercase;
    letter-spacing: 0.08em; font-weight: 500; text-decoration: none;
    white-space: nowrap;
  }
  header.site .brand .dot { color: var(--muted); margin: 0 8px; }
  header.site nav {
    display: flex; gap: 18px; font-family: var(--mono);
    flex-wrap: wrap; justify-content: flex-end;
  }
  header.site nav a {
    color: var(--muted); text-decoration: none;
    text-transform: uppercase; letter-spacing: 0.06em; font-size: 11.5px;
    transition: color var(--t);
  }
  header.site nav a:hover { color: var(--ink); }

  @media (max-width: 480px) {
    header.site .row { padding: 12px var(--gutter); gap: 12px; }
    header.site nav { gap: 14px; }
    header.site .brand .dot { margin: 0 6px; }
  }

  main { max-width: var(--maxw); margin: 0 auto; padding: 32px var(--gutter) 96px; }

  @media (max-width: 640px) {
    main { padding: 24px var(--gutter) 64px; }
  }

  /* Type primitives — fluid scale */
  .eyebrow {
    font-family: var(--mono); font-size: 11px; text-transform: uppercase;
    letter-spacing: 0.1em; color: var(--muted); margin: 0 0 10px;
  }
  h1 {
    margin: 0; font-family: var(--sans); font-weight: 600;
    letter-spacing: -0.022em; word-wrap: break-word; overflow-wrap: break-word;
  }
  h1.page   { font-size: clamp(24px, 4.4vw, 32px); line-height: 1.15; margin-bottom: 8px; }
  h1.entity { font-size: clamp(22px, 4vw, 28px);   line-height: 1.15; margin-bottom: 4px; }
  h1.home   { font-size: clamp(28px, 5.4vw, 40px); line-height: 1.1;  max-width: 22ch; letter-spacing: -0.025em; }
  h2 {
    margin: 0; font-family: var(--mono); font-size: 11px; font-weight: 500;
    text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted);
  }
  p { color: var(--ink-2); max-width: 64ch; margin: 0; }
  p.muted { color: var(--muted); }
  .desc {
    color: var(--ink-2); font-size: clamp(14px, 1.6vw, 15px);
    line-height: 1.55; max-width: 76ch; margin-top: 8px;
  }

  code, .mono { font-family: var(--mono); font-size: 12.5px; }
  code.inline {
    background: var(--border-soft); padding: 1px 5px; font-size: 0.9em;
    color: var(--ink); border-radius: 2px;
  }

  /* Masthead — newspaper rule meta strip */
  .masthead {
    margin: 24px 0 0;
    border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
    display: grid; grid-auto-flow: column; grid-auto-columns: max-content;
    gap: 0; overflow-x: auto;
    scrollbar-width: thin;
    -webkit-overflow-scrolling: touch;
  }
  .masthead::-webkit-scrollbar { height: 3px; }
  .masthead::-webkit-scrollbar-thumb { background: var(--border); }
  .masthead .cell {
    padding: 12px 20px; border-right: 1px solid var(--border);
    display: flex; flex-direction: column; gap: 4px;
    font-family: var(--mono); min-width: 0;
  }
  .masthead .cell:first-child { padding-left: 0; }
  .masthead .cell:last-child { border-right: none; padding-right: 0; }
  .masthead .key {
    font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.1em;
    color: var(--muted);
  }
  .masthead .val { font-size: 13px; color: var(--ink); }
  .masthead .val a { color: var(--ink); text-decoration: none; }
  .masthead .val a:hover { text-decoration: underline; text-decoration-color: var(--ink); }

  @media (max-width: 640px) {
    .masthead {
      display: flex; flex-wrap: wrap; overflow: visible;
    }
    .masthead .cell {
      flex: 1 1 calc(50% - 1px);
      padding: 10px 12px;
      border-right: 1px solid var(--border);
      border-bottom: 1px solid var(--border-soft);
    }
    .masthead .cell:first-child { padding-left: 12px; }
    .masthead .cell:last-child { padding-right: 12px; border-right: none; }
    .masthead .cell:nth-child(2n) { border-right: none; }
  }

  /* Action row — bracketed mono links */
  .actions {
    display: flex; flex-wrap: wrap; gap: 10px; margin: 20px 0 40px;
    font-family: var(--mono); font-size: 12px;
  }
  .actions a {
    color: var(--ink); text-decoration: none; padding: 6px 12px;
    border: 1px solid var(--border); background: var(--bg);
    text-transform: lowercase;
    transition: border-color var(--t), background var(--t), color var(--t);
  }
  .actions a:hover { border-color: var(--ink); background: var(--bg-soft); }
  .actions a .arr { color: var(--muted); margin-left: 6px; transition: color var(--t); }
  .actions a:hover .arr { color: var(--ink); }

  /* Filter row */
  .filter {
    display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
    font-family: var(--mono); font-size: 11.5px; margin: 0 0 12px;
    padding: 10px 0;
    border-top: 1px solid var(--border-soft); border-bottom: 1px solid var(--border-soft);
  }
  .filter .label {
    color: var(--muted); text-transform: uppercase; letter-spacing: 0.1em;
    font-size: 10.5px; margin-right: 8px;
  }
  .filter a {
    color: var(--ink); text-decoration: none;
    padding: 3px 9px; border: 1px solid var(--border);
    transition: border-color var(--t), background var(--t), color var(--t);
  }
  .filter a:hover { border-color: var(--ink); }
  .filter a.on { background: var(--ink); color: var(--bg); border-color: var(--ink); }
  .filter a .n { color: var(--muted); margin-left: 5px; font-size: 10.5px; }
  .filter a.on .n { color: var(--bg); opacity: 0.6; }
  .filter .clear {
    color: var(--muted); margin-left: 6px; padding: 0 6px;
    text-decoration: none; font-size: 10.5px;
  }
  .filter .clear:hover { color: var(--ink); }

  /* Tables — horizontal scroll wrapper */
  .scroll {
    width: 100%;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: thin;
    /* fade hint that there's more to the right */
    background:
      linear-gradient(90deg, var(--bg), transparent 12px),
      linear-gradient(-90deg, var(--bg), transparent 12px),
      linear-gradient(90deg, rgba(0,0,0,0.08), transparent 8px) 0 0 / 8px 100% no-repeat,
      linear-gradient(-90deg, rgba(0,0,0,0.08), transparent 8px) 100% 0 / 8px 100% no-repeat;
    background-attachment: local, local, scroll, scroll;
  }
  @media (prefers-color-scheme: dark) {
    .scroll {
      background:
        linear-gradient(90deg, var(--bg), transparent 12px),
        linear-gradient(-90deg, var(--bg), transparent 12px),
        linear-gradient(90deg, rgba(255,255,255,0.06), transparent 8px) 0 0 / 8px 100% no-repeat,
        linear-gradient(-90deg, rgba(255,255,255,0.06), transparent 8px) 100% 0 / 8px 100% no-repeat;
      background-attachment: local, local, scroll, scroll;
    }
  }
  .scroll::-webkit-scrollbar { height: 6px; }
  .scroll::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  .scroll::-webkit-scrollbar-track { background: transparent; }

  table.data {
    width: 100%; border-collapse: collapse;
    border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  table.data th, table.data td {
    padding: 10px 14px; text-align: left; vertical-align: top;
    border-bottom: 1px solid var(--border-soft);
    border-right: 1px solid var(--border-soft);
    white-space: nowrap;
  }
  table.data tr:last-child td { border-bottom: none; }
  table.data th:last-child, table.data td:last-child { border-right: none; }
  table.data th {
    font-family: var(--mono); font-weight: 500; font-size: 10.5px;
    text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted);
    background: var(--bg); padding-top: 12px; padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
    position: sticky; top: 0;
  }
  table.data tr { transition: background var(--t); }
  table.data tr:hover td { background: var(--row-hover); }
  table.data td.name a {
    color: var(--ink); text-decoration: none; font-weight: 500;
  }
  table.data td.name a:hover {
    text-decoration: underline; text-underline-offset: 2px; text-decoration-thickness: 1px;
  }
  table.data td.id, table.data td.mono {
    font-family: var(--mono); font-size: 12px; color: var(--ink-2);
  }
  table.data td.mono.muted { color: var(--muted); }
  table.data td.num {
    font-family: var(--mono); text-align: right; font-variant-numeric: tabular-nums;
  }
  table.data .empty { color: var(--muted); }
  table.data .empty::before { content: "—"; }

  @media (max-width: 640px) {
    table.data th, table.data td { padding: 9px 10px; font-size: 12.5px; }
  }

  /* Source affordance */
  .src-mark {
    display: inline; font-family: var(--mono); font-size: 10.5px;
    color: var(--muted); margin-left: 6px; vertical-align: super; line-height: 1;
    text-decoration: none;
  }
  .src-mark:hover { color: var(--ink); text-decoration: none; }

  /* Pager */
  .pager {
    margin-top: 16px; display: flex; gap: 18px; align-items: baseline;
    font-family: var(--mono); font-size: 11.5px; color: var(--muted);
    flex-wrap: wrap;
  }
  .pager a { color: var(--ink); text-decoration: none; }
  .pager a:hover { text-decoration: underline; }

  /* Repo index — frame card list */
  .frames-list {
    border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
    margin: 24px 0;
  }
  .frames-list a.card {
    display: grid; grid-template-columns: 1fr auto auto auto;
    gap: 24px; align-items: baseline;
    padding: 18px 4px; border-bottom: 1px solid var(--border-soft);
    text-decoration: none; color: var(--ink);
    transition: background var(--t);
  }
  .frames-list a.card:last-child { border-bottom: none; }
  .frames-list a.card:hover { background: var(--row-hover); }
  .frames-list a.card .title {
    font-size: clamp(15px, 2vw, 16px); font-weight: 500;
  }
  .frames-list a.card .path {
    font-family: var(--mono); font-size: 11px; color: var(--muted); margin-top: 2px;
    word-break: break-all;
  }
  .frames-list a.card .desc {
    color: var(--ink-2); font-size: 13px; margin-top: 6px;
    max-width: 60ch; line-height: 1.45;
  }
  .frames-list a.card .col {
    font-family: var(--mono); font-size: 12px; color: var(--muted);
    white-space: nowrap; min-width: 7ch; text-align: right;
  }
  .frames-list a.card .col .k {
    display: block; font-size: 10px; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--muted); margin-bottom: 2px;
  }
  .frames-list a.card .col .v { color: var(--ink); }

  @media (max-width: 720px) {
    .frames-list a.card {
      grid-template-columns: 1fr 1fr;
      gap: 12px 16px;
      padding: 16px 4px;
    }
    .frames-list a.card > div:first-child { grid-column: 1 / -1; }
    .frames-list a.card .col { text-align: left; }
  }

  /* Entity view */
  .breadcrumb {
    font-family: var(--mono); font-size: 11.5px; color: var(--muted);
    text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 18px;
  }
  .breadcrumb a { color: var(--muted); text-decoration: none; transition: color var(--t); }
  .breadcrumb a:hover { color: var(--ink); }
  .entity-id {
    font-family: var(--mono); font-size: 12px; color: var(--muted);
    margin-bottom: 36px; word-break: break-all;
  }

  table.fields {
    width: 100%; border-collapse: collapse;
    border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
    margin-bottom: 48px; font-size: 13px;
  }
  table.fields td {
    padding: 10px 0; border-bottom: 1px solid var(--border-soft); vertical-align: top;
  }
  table.fields tr:last-child td { border-bottom: none; }
  table.fields td.k {
    width: 220px; font-family: var(--mono); font-size: 11.5px; color: var(--muted);
    text-transform: uppercase; letter-spacing: 0.08em; padding-top: 13px;
  }
  table.fields td.k .req {
    display: inline-block; margin-left: 6px; padding: 0 5px;
    font-size: 9.5px; letter-spacing: 0.06em; color: var(--muted);
    border: 1px solid var(--border);
  }
  table.fields td.v { color: var(--ink); word-break: break-word; }
  table.fields td.v a { color: var(--link); text-decoration: none; word-break: break-all; }
  table.fields td.v a:hover { text-decoration: underline; }
  table.fields td.v .mono { color: var(--ink-2); }
  table.fields td.s {
    width: 280px; text-align: right; font-family: var(--mono);
    font-size: 11.5px; color: var(--muted); white-space: nowrap;
    padding-left: 16px;
  }
  table.fields td.s a { color: var(--ink-2); text-decoration: none; }
  table.fields td.s a:hover { text-decoration: underline; }
  table.fields td.t {
    width: 100px; text-align: right; font-family: var(--mono);
    font-size: 11px; color: var(--muted); white-space: nowrap; padding-top: 13px;
    padding-left: 12px;
  }

  /* Stack the fields table on small screens — collapse to 2 rows per field */
  @media (max-width: 720px) {
    table.fields, table.fields tbody, table.fields tr, table.fields td { display: block; width: 100%; }
    table.fields tr {
      padding: 14px 0;
      border-bottom: 1px solid var(--border-soft);
    }
    table.fields tr:last-child { border-bottom: none; }
    table.fields td { border: none; padding: 0; }
    table.fields td.k {
      width: auto; padding: 0 0 4px;
      display: flex; align-items: center; gap: 8px;
    }
    table.fields td.v { padding: 2px 0 6px; font-size: 14px; }
    table.fields td.s, table.fields td.t {
      width: auto; text-align: left; padding: 0; display: inline;
    }
    table.fields td.s::after { content: " · "; color: var(--muted); }
    table.fields td.t:empty { display: none; }
    table.fields td.s:empty + td.t:empty { display: none; }
  }

  /* Recent activity — frame view */
  .recent-list {
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    margin-top: 12px;
  }
  .recent-item {
    display: grid;
    grid-template-columns: 110px 64px minmax(0, 1fr);
    gap: 12px;
    align-items: baseline;
    padding: 10px 4px;
    border-bottom: 1px solid var(--border-soft);
    font-size: 13px;
  }
  .recent-item:last-child { border-bottom: none; }
  .recent-item .ts {
    font-family: var(--mono); font-size: 11.5px; color: var(--muted);
    white-space: nowrap;
  }
  .recent-item .label {
    font-family: var(--mono); font-size: 10.5px; color: var(--muted);
    text-transform: uppercase; letter-spacing: 0.08em;
  }
  .recent-item .label.new { color: var(--ink); }
  .recent-item .body {
    min-width: 0;
    display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px;
  }
  .recent-item .body a.entity-link {
    color: var(--ink); text-decoration: none; font-weight: 500;
  }
  .recent-item .body a.entity-link:hover { text-decoration: underline; }
  .recent-item .body .field {
    font-family: var(--mono); font-size: 11.5px; color: var(--muted);
    text-transform: uppercase; letter-spacing: 0.06em;
  }
  .recent-item .body .arrow { color: var(--muted); }
  .recent-item .body .value {
    font-family: var(--mono); font-size: 12px; color: var(--ink-2);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    max-width: 48ch;
  }
  .recent-item .body .value.was {
    color: var(--muted); text-decoration: line-through;
    text-decoration-color: var(--border);
  }

  @media (max-width: 640px) {
    .recent-item {
      grid-template-columns: 1fr;
      gap: 4px;
      padding: 12px 4px;
    }
    .recent-item .ts { order: 3; }
    .recent-item .body .value { max-width: 100%; white-space: normal; }
  }

  /* History timeline — per field block */
  .field-history { padding: 24px 0; border-bottom: 1px solid var(--border-soft); }
  .field-history:first-child { padding-top: 8px; }
  .field-history:last-child { border-bottom: none; }
  .field-history .field-name {
    font-family: var(--mono); font-size: 11px; color: var(--muted);
    text-transform: uppercase; letter-spacing: 0.1em;
    margin-bottom: 12px;
    display: flex; align-items: baseline; gap: 10px;
  }
  .field-history .field-name .count {
    color: var(--ink-2); font-size: 10.5px;
  }

  .status-pill {
    display: inline-block; padding: 0 6px; font-family: var(--mono);
    font-size: 9.5px; letter-spacing: 0.06em; text-transform: uppercase;
    border: 1px solid var(--border); color: var(--muted);
  }
  .status-pill.current { color: var(--ink); border-color: var(--ink); }
  .status-pill.deprecated { color: var(--muted); text-decoration: line-through; }
  .status-pill.superseded { color: var(--muted); }

  /* Inline revisions hint in the fields table */
  table.fields td.v .revisions {
    font-family: var(--mono); font-size: 10.5px; color: var(--muted);
    margin-left: 8px; text-transform: uppercase; letter-spacing: 0.06em;
    text-decoration: none;
  }
  table.fields td.v .revisions:hover { color: var(--ink); }

  /* Evidence — mono transcript style */
  .evidence-list { border-top: 1px solid var(--border); }
  .evidence-list .item {
    padding: 20px 0; border-bottom: 1px solid var(--border-soft);
  }
  .evidence-list .item:last-child { border-bottom: none; }
  .evidence-list .item .head {
    display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
    margin-bottom: 12px;
  }
  .evidence-list .item .field {
    font-family: var(--mono); font-size: 11px; color: var(--muted);
    text-transform: uppercase; letter-spacing: 0.1em;
  }
  .evidence-list .item .value {
    font-family: var(--mono); font-size: 13.5px; color: var(--ink);
    background: var(--border-soft); padding: 2px 8px;
    word-break: break-word; max-width: 100%;
  }
  .evidence-list .item .meta {
    margin-left: auto; font-family: var(--mono); font-size: 11px; color: var(--muted);
    word-break: break-word;
  }
  .evidence-list .item .meta a { color: var(--ink-2); text-decoration: none; }
  .evidence-list .item .meta a:hover { text-decoration: underline; }
  .evidence-list .item blockquote {
    margin: 0; padding: 12px 16px;
    border-left: 2px solid var(--border);
    font-family: var(--sans); font-size: 14px; line-height: 1.55;
    color: var(--ink); max-width: 76ch;
  }
  .evidence-list .item blockquote::before { content: "“"; color: var(--muted); margin-right: 2px; }
  .evidence-list .item blockquote::after  { content: "”"; color: var(--muted); margin-left: 2px; }

  @media (max-width: 640px) {
    .evidence-list .item .meta { margin-left: 0; flex-basis: 100%; }
    .evidence-list .item blockquote { padding: 10px 12px; }
  }

  /* Connect block */
  details.connect {
    margin: 64px 0 0; padding-top: 24px; border-top: 1px solid var(--border);
  }
  details.connect summary {
    list-style: none; cursor: pointer;
    font-family: var(--mono); font-size: 11px; text-transform: uppercase;
    letter-spacing: 0.1em; color: var(--ink);
    display: flex; align-items: center; gap: 10px;
  }
  details.connect summary::-webkit-details-marker { display: none; }
  details.connect summary::before { content: "[+]"; color: var(--muted); }
  details.connect[open] summary::before { content: "[−]"; color: var(--muted); }
  details.connect .body { padding-top: 16px; }
  details.connect pre {
    background: var(--code-bg); color: var(--code-ink);
    border: 1px solid var(--code-bg); padding: 16px 20px;
    font-family: var(--mono); font-size: 12px; line-height: 1.55;
    overflow-x: auto; margin: 12px 0; border-radius: 2px;
  }
  details.connect .note {
    font-family: var(--mono); font-size: 10.5px; color: var(--muted);
    text-transform: uppercase; letter-spacing: 0.08em;
  }

  /* Section spacers */
  section { margin-bottom: 48px; }
  section:last-child { margin-bottom: 0; }

  @media (max-width: 640px) {
    section { margin-bottom: 36px; }
    details.connect { margin-top: 48px; }
    table.fields { margin-bottom: 36px; }
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      transition: none !important;
      animation: none !important;
    }
  }
`);

function shell(titleText: string, body: Html | string): Html {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${titleText}</title>
${FONT_LINK}
<style>${STYLE}</style>
</head>
<body>
<header class="site">
  <div class="row">
    <a href="/" class="brand">frames<span class="dot">·</span>cloud</a>
    <nav>
      <a href="/microchipgnu/frames-examples">example</a>
      <a href="https://github.com/microchipgnu/frames-cloud">source</a>
    </nav>
  </div>
</header>
<main>
${body}
</main>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function relativeTime(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return iso.split("T")[0] ?? iso;
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return iso.split("T")[0] ?? iso;
}

function displayValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

function fieldCellPlain(value: unknown): Html {
  if (value === undefined || value === null) {
    return html`<span class="empty"></span>`;
  }
  if (typeof value === "string" && value.startsWith("http")) {
    return html`<a class="plain" href="${value}" target="_blank" rel="noopener">${host(value)}</a>`;
  }
  return html`<span>${String(value)}</span>`;
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

export type HomeFrame = {
  frame_path: string;
  schema_name?: string;
  description?: string;
  entity_count?: number;
  max_ts?: string;
};

export type HomeData = {
  user: string;
  repo: string;
  sha: string;
  frames: HomeFrame[];
} | null;

export function renderHome(data: HomeData): Html {
  const fallbackUser = "microchipgnu";
  const fallbackRepo = "frames-examples";
  const exampleUser = data?.user ?? fallbackUser;
  const exampleRepo = data?.repo ?? fallbackRepo;
  const exampleUrl = `/${exampleUser}/${exampleRepo}`;
  const githubUrl = `https://github.com/${exampleUser}/${exampleRepo}`;

  const totalEntities = data
    ? data.frames.reduce((n, f) => n + (f.entity_count ?? 0), 0)
    : 0;
  const maxTs = data
    ? data.frames.reduce<string>(
        (m, f) => (f.max_ts && (!m || f.max_ts > m) ? f.max_ts : m),
        "",
      )
    : "";

  const cards =
    data && data.frames.length > 0
      ? data.frames.map((f) => {
          const url = `/${data.user}/${data.repo}${f.frame_path ? "/" + f.frame_path : ""}`;
          return html`<a class="card" href="${url}">
            <div>
              <div class="title">${f.schema_name ?? f.frame_path}</div>
              <div class="path">${f.frame_path || "(root)"}</div>
              ${f.description
                ? html`<div class="desc">${f.description.split("\n")[0]}</div>`
                : ""}
            </div>
            <div class="col"><span class="k">entities</span><span class="v">${f.entity_count ?? "—"}</span></div>
            <div class="col"><span class="k">updated</span><span class="v">${f.max_ts ? f.max_ts.split("T")[0] : "—"}</span></div>
          </a>`;
        })
      : [
          html`<a class="card" href="${exampleUrl}">
            <div>
              <div class="title">${fallbackRepo}</div>
              <div class="path">github.com / ${fallbackUser} / ${fallbackRepo}</div>
            </div>
            <div class="col"><span class="k">open</span><span class="v">→</span></div>
          </a>`,
        ];

  const body = html`
<section>
  <div class="eyebrow">frames-cloud</div>
  <h1 class="home">Live datasets from any public GitHub repo.</h1>
  <p class="desc">A frame is a folder with <code class="inline">schema.yml</code> and <code class="inline">events.ndjson</code>. Push it to GitHub — the URL works. JSON API, table view, and per-cell source provenance, served from any commit.</p>
</section>

<section>
  <h2>example</h2>
  <div class="masthead">
    <div class="cell"><span class="key">repo</span><span class="val"><a href="${githubUrl}">${exampleUser}/${exampleRepo}</a></span></div>
    ${data
      ? html`<div class="cell"><span class="key">frames</span><span class="val">${data.frames.length}</span></div>
        <div class="cell"><span class="key">entities</span><span class="val">${totalEntities}</span></div>
        ${maxTs ? html`<div class="cell"><span class="key">updated</span><span class="val">${maxTs.split("T")[0]}</span></div>` : ""}
        <div class="cell"><span class="key">commit</span><span class="val">${data.sha.slice(0, 7)}</span></div>`
      : html`<div class="cell"><span class="key">status</span><span class="val">live</span></div>`}
  </div>
  <div class="frames-list" style="margin-top: 0; border-top: none;">${cards}</div>
</section>

<details class="connect">
  <summary>api reference</summary>
  <div class="body">
    <p class="muted" style="font-family: var(--mono); font-size: 11.5px;">URL = filesystem path inside the repo. <code class="inline">&lt;frame_path&gt;</code> is optional for single-frame repos.</p>
    <div class="scroll" style="margin-top: 12px;">
      <table class="data">
        <thead><tr><th>path</th><th>response</th></tr></thead>
        <tbody>
          <tr><td class="mono">/&lt;user&gt;/&lt;repo&gt;[/&lt;frame_path&gt;]</td><td>html — entity table</td></tr>
          <tr><td class="mono">/&lt;user&gt;/&lt;repo&gt;[/&lt;frame_path&gt;]/entities/&lt;id&gt;</td><td>html — entity detail with evidence</td></tr>
          <tr><td class="mono">/api/v1/&lt;user&gt;/&lt;repo&gt;[/&lt;frame_path&gt;]/entities</td><td>json — paginated, cursor on entity_id</td></tr>
          <tr><td class="mono">/api/v1/&lt;user&gt;/&lt;repo&gt;[/&lt;frame_path&gt;]/entities/&lt;id&gt;</td><td>json — full entity + all evidence</td></tr>
          <tr><td class="mono">/api/v1/&lt;user&gt;/&lt;repo&gt;[/&lt;frame_path&gt;]/schema</td><td>json — schema as JSON</td></tr>
          <tr><td class="mono">/api/v1/&lt;user&gt;/&lt;repo&gt;/_frames</td><td>json — every schema.yml in the repo</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</details>
`;
  return shell("frames-cloud", body);
}

// ---------------------------------------------------------------------------
// Repo index
// ---------------------------------------------------------------------------

export type RepoFrameSummary = {
  slug: string;
  frame_path: string;
  schema_name?: string;
  description?: string;
  entity_count?: number;
  max_ts?: string;
  error?: string;
};

export function renderRepoIndex(
  user: string,
  repo: string,
  sha: string,
  frames: RepoFrameSummary[],
): Html {
  const githubUrl = `https://github.com/${user}/${repo}`;
  const cards = frames.map((f) => {
    const url = `/${user}/${repo}${f.frame_path ? "/" + f.frame_path : ""}`;
    return html`<a class="card" href="${url}">
      <div>
        <div class="title">${f.schema_name ?? f.slug}</div>
        <div class="path">${f.frame_path || "(root)"}</div>
        ${f.description ? html`<div class="desc">${f.description.split("\n")[0]}</div>` : ""}
      </div>
      <div class="col"><span class="k">entities</span><span class="v">${f.entity_count ?? "—"}</span></div>
      <div class="col"><span class="k">updated</span><span class="v">${f.max_ts ? f.max_ts.split("T")[0] : "—"}</span></div>
      <div class="col"><span class="k">path</span><span class="v">${f.frame_path || "."}</span></div>
    </a>`;
  });

  const body = html`
<section>
  <div class="eyebrow">multi-frame repository</div>
  <h1 class="page">${user}/${repo}</h1>
  <p class="desc">${frames.length} ${frames.length === 1 ? "frame" : "frames"}. Each is a directory with its own schema.yml and events.ndjson.</p>
</section>

<div class="masthead">
  <div class="cell"><span class="key">repo</span><span class="val"><a href="${githubUrl}">${user}/${repo}</a></span></div>
  <div class="cell"><span class="key">commit</span><span class="val">${sha.slice(0, 7)}</span></div>
  <div class="cell"><span class="key">frames</span><span class="val">${frames.length}</span></div>
</div>

<section>
  <h2>frames</h2>
  <div class="frames-list">${cards}</div>
</section>

<section>
  <h2>api</h2>
  <p class="muted" style="font-family: var(--mono); font-size: 12px;">GET /api/v1/${user}/${repo}/_frames &nbsp;·&nbsp; GET /api/v1/${user}/${repo}/&lt;frame_path&gt;/entities</p>
</section>
`;
  return shell(`${user}/${repo} — frames-cloud`, body);
}

// ---------------------------------------------------------------------------
// Frame view (the headline page)
// ---------------------------------------------------------------------------

export function renderFrame(
  ds: Dataset,
  entities: Entity[],
  page: { next_cursor: string | null; has_more: boolean },
  filters: Record<string, string[]>,
  countryCounts: Map<string, number>,
  recent: RecentActivity[],
): Html {
  const fieldOrder = Object.keys(ds.schema.fields);
  // skip "name" — we render it as the row header. include up to 6 more.
  const visibleFields = fieldOrder.filter((f) => f !== "name").slice(0, 6);
  const githubUrl = `https://github.com/${ds.user}/${ds.repo}${
    ds.frame_path ? `/tree/main/${ds.frame_path}` : ""
  }`;
  const apiUrl = `/api/v1/${ds.user}/${ds.repo}${ds.frame_path ? "/" + ds.frame_path : ""}/entities`;
  const mcpUrl = `/mcp/${ds.user}/${ds.repo}${ds.frame_path ? "/" + ds.frame_path : ""}`;
  const activeCountries = filters.hq_country ?? [];
  const countryRow = ds.schema.fields.hq_country?.values ?? [];
  const path = `/${ds.user}/${ds.repo}${ds.frame_path ? "/" + ds.frame_path : ""}`;
  const totalEntities = [...ds.entities.values()].filter((e) => !e.removed).length;

  const filterLink = (val: string, count: number, isActive: boolean) => {
    let next = activeCountries.slice();
    if (isActive) next = next.filter((v) => v !== val);
    else next.push(val);
    const qs = next.length > 0 ? `?filter[hq_country]=${next.join(",")}` : "";
    return html`<a class="${isActive ? "on" : ""}" href="${path + qs}">${val}<span class="n">${count}</span></a>`;
  };

  const filterBar =
    countryRow.length > 0
      ? html`<div class="filter">
  <span class="label">hq_country</span>
  ${countryRow
    .filter((c) => (countryCounts.get(c) ?? 0) > 0)
    .map((c) => filterLink(c, countryCounts.get(c) ?? 0, activeCountries.includes(c)))}
  ${activeCountries.length > 0 ? html`<a class="clear" href="${path}">[clear]</a>` : ""}
</div>`
      : "";

  const recentItems = recent.map((r) => {
    const entityHref = `${path}/entities/${r.entity_id}`;
    if (r.type === "created") {
      return html`<div class="recent-item">
        <span class="ts" title="${r.ts}">${relativeTime(r.ts)}</span>
        <span class="label new">new</span>
        <div class="body">
          <a class="entity-link" href="${entityHref}">${r.entity_name}</a>
        </div>
      </div>`;
    }
    const newVal = displayValue(r.value);
    const oldVal = r.previous !== undefined ? displayValue(r.previous) : null;
    return html`<div class="recent-item">
      <span class="ts" title="${r.ts}">${relativeTime(r.ts)}</span>
      <span class="label">update</span>
      <div class="body">
        <a class="entity-link" href="${entityHref}#hist-${r.field}">${r.entity_name}</a>
        <span class="field">${r.field}</span>
        ${oldVal !== null ? html`<span class="value was">${oldVal}</span><span class="arrow">→</span>` : ""}
        <span class="value">${newVal}</span>
      </div>
    </div>`;
  });

  const recentSection =
    recent.length > 0
      ? html`<section id="activity">
  <h2>activity · last ${recent.length} ${recent.length === 1 ? "change" : "changes"}</h2>
  <div class="recent-list">${recentItems}</div>
</section>`
      : "";

  const colHeaders = html`
    <th>name</th>
    <th>id</th>
    ${visibleFields.map((f) => html`<th>${f}</th>`)}
  `;

  const rows = entities.map((e) => {
    const cells = visibleFields.map((f) => {
      const v = e.fields[f];
      const isMonoField = ["hq_country", "founded_year", "category", "funding_stage", "last_news_date"].includes(f);
      const isLink = typeof v === "string" && v.startsWith("http");
      if (v === undefined || v === null) return html`<td><span class="empty"></span></td>`;
      if (isLink) return html`<td class="mono"><a class="plain" href="${v as string}" target="_blank" rel="noopener">${host(v as string)}</a></td>`;
      if (isMonoField) return html`<td class="mono">${String(v)}</td>`;
      return html`<td>${String(v)}</td>`;
    });
    return html`<tr>
      <td class="name"><a href="${path}/entities/${e.entity_id}">${String(e.fields.name ?? e.entity_id)}</a></td>
      <td class="id mono muted">${e.entity_id}</td>
      ${cells}
    </tr>`;
  });

  const body = html`
<section>
  <div class="eyebrow">${ds.schema.entity_type ?? "entity"} · ${ds.user}/${ds.repo}${ds.frame_path ? "/" + ds.frame_path : ""}</div>
  <h1 class="page">${ds.schema.name}</h1>
  <p class="desc">${(ds.schema.description ?? "").split("\n").join(" ").trim()}</p>
</section>

<div class="masthead">
  <div class="cell"><span class="key">repo</span><span class="val"><a href="${githubUrl}">${ds.user}/${ds.repo}${ds.frame_path ? "/" + ds.frame_path : ""}</a></span></div>
  <div class="cell"><span class="key">commit</span><span class="val">${ds.sha.slice(0, 7)}</span></div>
  <div class="cell"><span class="key">entities</span><span class="val">${totalEntities}</span></div>
  <div class="cell"><span class="key">updated</span><span class="val">${ds.max_ts ? ds.max_ts.split("T")[0] : "—"}</span></div>
  <div class="cell"><span class="key">protocol</span><span class="val">${ds.schema.frame_protocol}</span></div>
</div>

<div class="actions">
  <a href="${apiUrl}">json<span class="arr">↗</span></a>
  <a href="/api/v1${path}/schema">schema<span class="arr">↗</span></a>
  <a href="${githubUrl}">github<span class="arr">↗</span></a>
  ${recent.length > 0
    ? html`<a href="#activity">activity<span class="arr">↓</span></a>`
    : ""}
  <a href="#mcp">mcp<span class="arr">↓</span></a>
</div>

<section>
  <h2>entities · ${entities.length} of ${totalEntities}</h2>
  ${filterBar}
  <div class="scroll">
  <table class="data">
    <thead><tr>${colHeaders}</tr></thead>
    <tbody>${rows}</tbody>
  </table>
  </div>
  <div class="pager">
    <span>showing ${entities.length}</span>
    ${page.next_cursor
      ? html`<a href="${path}?cursor=${page.next_cursor}${
          activeCountries.length > 0 ? `&filter[hq_country]=${activeCountries.join(",")}` : ""
        }">next →</a>`
      : html`<span>end of results</span>`}
  </div>
</section>

${recentSection}

<details class="connect" id="mcp">
  <summary>connect via mcp http</summary>
  <div class="body">
    <p class="muted" style="font-family: var(--mono); font-size: 11.5px;">add to .mcp.json — anonymous reads, oauth-gated writes (coming).</p>
    <pre><code>{
  "mcpServers": {
    "${ds.schema.name}": {
      "type": "http",
      "url": "${mcpUrl}"
    }
  }
}</code></pre>
    <p class="note">mcp http runtime — coming. json api works today.</p>
  </div>
</details>
`;
  return shell(`${ds.schema.name} — frames-cloud`, body);
}

// ---------------------------------------------------------------------------
// Entity view
// ---------------------------------------------------------------------------

export function renderEntity(ds: Dataset, ent: Entity): Html {
  const path = `/${ds.user}/${ds.repo}${ds.frame_path ? "/" + ds.frame_path : ""}`;

  const fieldRows = Object.keys(ds.schema.fields).map((f) => {
    const v = ent.fields[f];
    const ev = ent.evidence[f];
    const fact = ent.facts[f];
    const required = ds.schema.fields[f]?.required;
    const revisions = ent.history[f]?.length ?? 0;
    const valueRender =
      v === undefined || v === null
        ? html`<span class="empty"></span>`
        : typeof v === "string" && v.startsWith("http")
          ? html`<a href="${v}" target="_blank" rel="noopener">${v}</a>`
          : typeof v === "string"
            ? html`<span>${v}</span>`
            : html`<span class="mono">${String(v)}</span>`;
    return html`<tr>
      <td class="k">${f}${required ? html`<span class="req">REQ</span>` : ""}</td>
      <td class="v">${valueRender}${
        revisions > 1
          ? html`<a class="revisions" href="#hist-${f}">${revisions} revisions</a>`
          : ""
      }</td>
      <td class="s">${ev ? html`<a href="${ev.url}" target="_blank" rel="noopener">${host(ev.url)}</a>` : ""}</td>
      <td class="t">${fact?.ts.split("T")[0] ?? ""}</td>
    </tr>`;
  });

  // Per-field history blocks. One block per field that has at least one fact.
  // Order: schema field order, then any extra (unknown) fields with facts.
  const schemaFieldOrder = Object.keys(ds.schema.fields);
  const extraFields = Object.keys(ent.history).filter((f) => !schemaFieldOrder.includes(f));
  const historyFieldOrder = [...schemaFieldOrder, ...extraFields].filter(
    (f) => (ent.history[f]?.length ?? 0) > 0,
  );

  const totalRevisions = historyFieldOrder.reduce(
    (n, f) => n + (ent.history[f]?.length ?? 0),
    0,
  );

  const historyBlocks = historyFieldOrder.map((f) => {
    const facts = ent.history[f]!.slice().sort((a, b) => b.ts.localeCompare(a.ts));
    const liveId = ent.facts[f]?.fact_id;
    const items = facts.map((fact) => {
      const status: "current" | "deprecated" | "superseded" =
        fact.deprecated
          ? "deprecated"
          : fact.fact_id === liveId
            ? "current"
            : "superseded";
      const valueDisplay =
        typeof fact.value === "string" ? fact.value : JSON.stringify(fact.value);
      return html`<div class="item">
        <div class="head">
          <span class="value">${valueDisplay}</span>
          <span class="status-pill ${status}">${status}</span>
          <span class="meta"><a href="${fact.source.url}" target="_blank" rel="noopener">${host(fact.source.url)}</a> · ${fact.ts.split("T")[0]}</span>
        </div>
        <blockquote>${fact.source.excerpt ?? "(no excerpt)"}</blockquote>
      </div>`;
    });
    return html`<div class="field-history" id="hist-${f}">
      <div class="field-name">${f}<span class="count">${facts.length} ${facts.length === 1 ? "revision" : "revisions"}</span></div>
      <div class="evidence-list">${items}</div>
    </div>`;
  });

  const body = html`
<div class="breadcrumb"><a href="${path}">← ${ds.schema.name}</a></div>
<h1 class="entity">${String(ent.fields.name ?? ent.entity_id)}</h1>
<div class="entity-id">${ent.entity_id}</div>

<section>
  <h2>fields</h2>
  <table class="fields" style="margin-top: 12px;">
    <tbody>${fieldRows}</tbody>
  </table>
</section>

<section>
  <h2>history · ${historyFieldOrder.length} ${historyFieldOrder.length === 1 ? "field" : "fields"} · ${totalRevisions} ${totalRevisions === 1 ? "revision" : "revisions"}</h2>
  <div style="margin-top: 12px; border-top: 1px solid var(--border);">
    ${historyBlocks}
  </div>
</section>
`;
  return shell(`${ent.fields.name ?? ent.entity_id} — frames-cloud`, body);
}
