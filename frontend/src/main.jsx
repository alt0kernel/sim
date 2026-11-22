import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {
  Activity, AlertCircle, AlertTriangle, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ArrowUpRight,
  BarChart3, Boxes, Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Clock3,
  Command, Compass, Crosshair, Download, Footprints, GitBranch, Headphones, Info, Layers3,
  LayoutDashboard, ListChecks, LocateFixed, Map, MapPinned, Maximize2, Mic, MicOff, Minus,
  Moon, MousePointer2, Navigation2, Package, Pause, Play, Plus, Radar, RefreshCw, RotateCcw,
  Route, ScanLine, Search, Settings2, ShieldAlert, ShoppingBag, ShoppingCart, SlidersHorizontal,
  Sparkles, Store, Sun, Target, Timer, Volume2, VolumeX, WandSparkles, Waypoints, X, Zap
} from 'lucide-react';
import {engineError, engineLabel, exportSession, readState, sendAction} from '#simulator';
import './studio.css';

const NAV = [
  {id:'Overview', label:'Overview', Icon:LayoutDashboard},
  {id:'Navigation', label:'Map explorer', Icon:Map},
  {id:'Shelves', label:'Shelf browser', Icon:Store},
  {id:'Vision lab', label:'Vision lab', Icon:ScanLine},
  {id:'Telemetry', label:'Analytics', Icon:BarChart3},
  {id:'Activity log', label:'Activity log', Icon:Activity},
];
const VIEWS = [{id:'floor',label:'Floor plan',Icon:Map},{id:'graph',label:'Network',Icon:GitBranch},{id:'density',label:'Density',Icon:Layers3},{id:'sensing',label:'Sensors',Icon:Radar}];
const DEFAULT_LAYERS = {routes:true, labels:true, shelves:true, grid:true, sensors:false, obstacles:true};
const MONEY = n => `₹${Number(n||0).toLocaleString('en-IN',{maximumFractionDigits:0})}`;
const NUM = (n,p=1)=>Number(n||0).toFixed(p);
const TIME = t => `${String(Math.floor(Number(t||0)/60)).padStart(2,'0')}:${String(Math.floor(Number(t||0)%60)).padStart(2,'0')}`;
const TITLE = n => n?.replaceAll('_',' ')||'—';
const statusLabel = state => ({NAVIGATING:'Navigating', AT_SHELF:'At shelf', HAZARD_OVERRIDE:'Safety override', COMPLETE:'Journey complete'})[state]||'Connecting';
const getNode = (s,id)=>s?.layout?.nodes?.find(n=>n.id===id);
const colorType = type => ['hazard','allergen','obstacle'].includes(type)?'danger':type==='complete'||type==='purchase'?'success':'neutral';
const EVENT_ICONS = {purchase:ShoppingBag,shelf:Store,stock:Package,hazard:ShieldAlert,obstacle:AlertTriangle,scan:ScanLine,
  arrival:MapPinned,reroute:Route,allergen:ShieldAlert,complete:CheckCircle2,start:Play,move:Footprints,
  mode:Settings2,voice:Volume2,safety:ShieldAlert,planner:GitBranch,clear:Check,environment:SlidersHorizontal,travel:Navigation2};

function productRequest(text){
  const match=text.trim().match(/^(?:please\s+)?(?:i\s+(?:want|need)(?:\s+to\s+(?:buy|get|find))?|(?:can|could)\s+i\s+get|find(?:\s+me)?|where\s+(?:is|are|can\s+i\s+find))\b\s*(.*)$/i);
  return match?match[1].replace(/[.,!?]+$/,'').replace(/\s+please$/i,'').replace(/^(?:some|an?|the)\s+/i,'').trim():null;
}

function IconButton({Icon,title,onClick,active=false,disabled=false}){return <button type="button" title={title} aria-label={title} onClick={onClick} disabled={disabled} className={'icon-btn'+(active?' is-active':'')}><Icon size={17}/></button>}
function Eyebrow({children}){return <span className="eyebrow">{children}</span>}
function Titlebar({kicker,title,action}){return <div className="card-titlebar"><div><Eyebrow>{kicker}</Eyebrow><h2>{title}</h2></div>{action}</div>}
function Pill({children,type='neutral',Icon}){return <span className={'pill pill-'+type}>{Icon&&<Icon size={12}/>} {children}</span>}
function Progress({value=0}){return <div className="progress-track" role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin="0" aria-valuemax="100"><div style={{width:`${Math.max(0,Math.min(100,value))}%`}}/></div>}
function MiniLine({values,highlight=false}){
  const array=values?.length>1?values:[4,3.8,4.1,3.3,3.6,3.1,3.5,3];const min=Math.min(...array,0),max=Math.max(...array,6);
  const path=array.map((v,i)=>`${i?'L':'M'}${i*100/(array.length-1)},${30-(v-min)/(max-min||1)*25}`).join(' ');
  return <svg className={'mini-line'+(highlight?' mini-highlight':'')} viewBox="0 0 100 34" preserveAspectRatio="none" aria-hidden="true"><path d={path} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
}

// All floor-plan data is read from the live native backend. Shelf regions have separate selection targets.
function StoreMap({s,view,layers,zoom,onNode,onShelf}){
  const coords=useMemo(()=>Object.fromEntries((s?.layout?.nodes||[]).map(n=>[n.id,n])),[s?.layout?.nodes]);
  const nodes=s?.layout?.nodes||[], edges=s?.layout?.edges||[], usr=s?.user||{x:95,y:580}, route=s?.route||[];
  const detour=s?.product_detour;
  const startsAtShopper=usr.heading_to&&route[0]===usr.node&&route[1]===usr.heading_to;
  const routePath=route.filter(id=>coords[id]).map((id,i)=>{
    const point=i===0&&startsAtShopper?usr:coords[id];
    return `${i?'L':'M'} ${point.x} ${point.y}`;
  }).join(' ');
  const aisleNodes=nodes.filter(n=>n.type==='aisle');
  const target=detour?.aisle||s?.goal?.node, selected=s?.selected_shelf?.id;
  const targetRack=detour?.shelf_id||s?.goal?.shelf_id;
  const heading=usr.heading_to&&coords[usr.heading_to];
  const angle=heading?Math.atan2(heading.y-usr.y,heading.x-usr.x)*180/Math.PI+90:0;
  return <div className={'store-map view-'+view}>
    <svg viewBox="0 0 1000 690" className="store-map-svg" style={{transform:`scale(${zoom})`}} role="img" aria-label="Interactive simulation map. Select aisle markers or individual shelf faces to navigate and browse inventory.">
      <defs>
        <pattern id="map-grid" patternUnits="userSpaceOnUse" width="25" height="25"><circle cx="1" cy="1" r="1" className="svg-grid-dot"/></pattern>
        <pattern id="rack-texture" patternUnits="userSpaceOnUse" width="8" height="8"><path d="M8 0L0 8" className="svg-rack-grain" fill="none" strokeWidth=".8"/></pattern>
        <filter id="player-shadow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="6"/></filter>
        <radialGradient id="sensing-gradient"><stop stopColor="var(--accent)" stopOpacity=".28"/><stop offset="1" stopColor="var(--accent)" stopOpacity="0"/></radialGradient>
      </defs>
      <rect width="1000" height="690" className="svg-stage"/>
      {layers.grid&&<rect width="1000" height="690" fill="url(#map-grid)"/>}
      <rect x="45" y="43" width="910" height="598" rx="23" className="svg-perimeter"/>
      <path d="M67 43h110 M823 43h110 M67 641h110 M823 641h110" className="svg-perimeter-highlight"/>
      {view==='density'&&aisleNodes.map((n,i)=><g key={n.id}>
        <circle cx={n.x} cy={n.y} r={80+(n.count||0)*8} fill={i%2===0?'var(--heat-a)':'var(--heat-b)'} opacity=".23"/>
        <circle cx={n.x} cy={n.y} r="51" fill="var(--heat-b)" opacity=".17"/>
      </g>)}
      <g>{edges.map((e,i)=>{const a=coords[e.a],b=coords[e.b];if(!a||!b)return null;
        return <g key={i}>
          <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={'svg-corridor'+(e.blocked?' is-blocked':'')} strokeWidth={view==='graph'?11:e.width>=4?24:19}/>
          {view==='graph'&&<g><rect x={(a.x+b.x)/2-19} y={(a.y+b.y)/2-12} width="38" height="24" rx="7" className="svg-edge-label"/>
             <text x={(a.x+b.x)/2} y={(a.y+b.y)/2+4} textAnchor="middle" className="svg-edge-distance">{NUM(e.meters)}m</text></g>}
          {e.blocked&&<g><circle cx={(a.x+b.x)/2} cy={(a.y+b.y)/2} r="13" className="svg-blocked"/><path d={`M${(a.x+b.x)/2-5} ${(a.y+b.y)/2-5}l10 10m0-10l-10 10`} className="svg-blocked-mark"/></g>}
        </g>;
      })}</g>
      {!['graph'].includes(view)&&layers.shelves&&aisleNodes.map(n=><g key={n.id}>
        <rect x={n.x-67} y={n.y-66} width="134" height="118" rx="10" className="svg-bay"/>
        <rect x={n.x-61} y={n.y-60} width="122" height="104" rx="7" fill="url(#rack-texture)" opacity=".45"/>
        {['L','R'].map((side,index)=>{
          const id=n.id+'_'+side, x=n.x+(index===0?-58:12), active=selected===id;
          return <g key={id} role="button" tabIndex="0" className={'svg-rack'+(active?' is-selected':'')+(id===targetRack?' is-route-target':'')}
            onClick={e=>{e.stopPropagation();onShelf(id)}} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onShelf(id)}}}
            aria-label={`View ${n.label} ${side==='L'?'left':'right'} shelf`}>
            <rect x={x} y={n.y-53} width="46" height="88" rx="6" className="svg-rack-background"/>
            {[0,1,2].map(k=><g key={k}>
              <rect x={x+5} y={n.y-47+k*27} width="36" height="21" rx="3" className="svg-product-slab"/>
              {[0,1,2].map(j=><rect key={j} x={x+9+j*10} y={n.y-42+k*27} width="7" height="11" rx="1.5" className="svg-product-detail"/>)}
            </g>)}
            <rect x={x+10} y={n.y-68} width="26" height="19" rx="5" className="svg-rack-label"/>
            <text x={x+23} y={n.y-55} textAnchor="middle" className="svg-rack-letter">{side}</text>
            <title>{n.label} / {side==='L'?'Left':'Right'} shelf — select to inspect products</title>
          </g>;
        })}
      </g>)}

      {layers.routes&&routePath&&<g className="route-overlay">
        <path d={routePath} className="svg-route-back"/>
        <path d={routePath} className="svg-route"/>
        {route.length>1&&coords[route[route.length-1]]&&<circle cx={coords[route[route.length-1]].x} cy={coords[route[route.length-1]].y} r="25" className="svg-destination-ring"/>}
      </g>}
      {(view==='sensing'||layers.sensors)&&<g transform={`translate(${usr.x} ${usr.y})`}>
        <circle r="155" fill="url(#sensing-gradient)"/>
        {[48,92,143].map(r=><circle key={r} r={r} className="svg-sensor-ring"/>)}
        <path d="M0 0L-137-100A175 175 0 0 1 137-100Z" className="svg-sensor-cone"/>
      </g>}
      {nodes.map(n=>{const isGoal=n.id===target;
        return <g key={n.id} role="button" tabIndex="0" className="svg-map-node" onClick={()=>onNode(n.id)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onNode(n.id)}}} aria-label={`Navigate to ${n.label}`}>
          {isGoal&&<circle cx={n.x} cy={n.y} r="28" className="svg-destination-ring"/>}
          <circle cx={n.x} cy={n.y} r={view==='graph'?16:11} className={'svg-node-circle'+(isGoal?' is-target':'')}/>
          <circle cx={n.x} cy={n.y} r="3" className="svg-node-inner"/>
          {layers.labels&&<g>
            <rect x={n.x-(n.label.length*3.6+13)} y={n.y+(n.type==='aisle'?54:18)} width={n.label.length*7.2+26} height="28" rx="8" className="svg-location-tag"/>
            <text x={n.x} y={n.y+(n.type==='aisle'?72:36)} textAnchor="middle" className="svg-location-text">{n.label}</text>
          </g>}
          <title>Navigate to {n.label}</title>
        </g>;
      })}
      {layers.obstacles&&(s?.obstacles||[]).map(o=>{
        const a=coords[o.a],b=coords[o.b];if(!a||!b)return null;
        const x=a.x+(b.x-a.x)*o.t,y=a.y+(b.y-a.y)*o.t;
        return <g key={o.id} transform={`translate(${x},${y})`}>
          <circle r="23" className="svg-hazard-halo"/><circle r="13" className="svg-hazard-core"/>
          <path d="M0-6V2 M0 7V8" className="svg-hazard-mark"/><title>{o.label}</title>
        </g>
      })}
      <g transform={`translate(${usr.x},${usr.y})`} className="svg-person">
        <circle r="33" className="svg-person-glow"/>
        <circle r="20" className="svg-person-disc"/>
        <circle r="12" className="svg-person-core"/>
        <g transform={`rotate(${angle})`}><path d="M0 -8L6 6L0 3L-6 6Z" fill="#fff"/></g>
      </g>
      <text x="68" y="80" className="svg-map-watermark">SAARATHI / DIGITAL FLOORPLAN</text>
      <text x="67" y="619" className="svg-map-caption">SIMULATED STORE SPACE · NOT TO SCALE</text>
    </svg>
    <div className="map-coordinate"><span className="live-point"/> LIVE TRACKING <b>{Math.round(usr.x)} : {Math.round(usr.y)}</b></div>
    <div className="map-compass"><Compass size={15}/> N <ArrowUp size={13}/></div>
    <div className="map-legend"><span><i className="legend-person"/> You</span><span><i className="legend-path"/> Planned route</span><span><i className="legend-target"/> Goal</span><span><i className="legend-alert"/> Hazard</span></div>
  </div>;
}

function MapPanel({s,onAction,view,setView,layers,setLayers,zoom,setZoom,openShelves}){
  const [layerMenu,setLayerMenu]=useState(false),[library,setLibrary]=useState(false);
  const maps=s?.options?.maps||[];
  return <section className="surface map-panel">
    <div className="map-panel-header"><div className="panel-heading-label"><div className="panel-icon"><MapPinned size={19}/></div><div><Eyebrow>LIVE FLOOR MODEL</Eyebrow><h2>Store navigator</h2></div></div>
      <div className="map-panel-header-right"><Pill type={s?.sensors?.hazard?'danger':s?.state==='COMPLETE'?'success':'accent'} Icon={s?.sensors?.hazard?AlertTriangle:Radar}>{statusLabel(s?.state)}</Pill>
        <button className="text-control" onClick={openShelves}><Store size={15}/> Browse shelves</button></div>
    </div>
    <div className="map-tools">
      <div className="segmented" role="group" aria-label="Map view">{VIEWS.map(({id,label,Icon})=><button key={id} aria-pressed={view===id} className={view===id?'on':''} onClick={()=>setView(id)}><Icon size={15}/><span>{label}</span></button>)}</div>
      <div className="map-tools-right"><button className={'small-outline'+(library?' selected-control':'')} aria-expanded={library} onClick={()=>{setLibrary(!library);setLayerMenu(false)}}><Waypoints size={15}/><span className="map-layout-label">{maps.find(m=>m.id===s?.map)?.label||'Choose layout'}</span><ChevronDown size={13}/></button>
        <IconButton Icon={Layers3} title="Map layers" active={layerMenu} onClick={()=>{setLayerMenu(!layerMenu);setLibrary(false)}}/>
      </div>
    </div>
    {(library||layerMenu)&&<div className="map-overlays">
    {library&&<div className="map-popover library-popover"><div className="popover-title"><b>Change store layout</b><IconButton Icon={X} title="Close" onClick={()=>setLibrary(false)}/></div><div className="layout-grid">{maps.map((m,i)=><button key={m.id} className={'layout-tile'+(m.id===s?.map?' is-current':'')} onClick={()=>{onAction('map',m.id);setLibrary(false);setZoom(1)}}>
       <div className="layout-glyph"><svg viewBox="0 0 98 52"><path d={['M9 44L27 28V8H72V28L89 44M27 28H72M50 8V28','M9 44L27 27V8H72V27L89 44M27 27H72M50 8V45','M10 43V8H88V43H10M26 8V28H72V8M50 28V43','M9 43H89M9 43V25H89M27 25V9H72V25','M16 43L28 28V13H70V28L82 43M28 28H70','M9 44V26H89V44M9 26L28 8H71L89 26M28 8V44M50 8V44M71 8V44'][i]||''} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></svg></div>
       <strong>{m.label}</strong><span>{m.description}</span>{m.id===s?.map&&<Check size={15} className="layout-check"/>}</button>)}</div><p>Switching a floor layout starts a new simulation session.</p></div>}
    {layerMenu&&<div className="map-popover layers-popover"><div className="popover-title"><b>Visible map layers</b><IconButton Icon={X} title="Close" onClick={()=>setLayerMenu(false)}/></div>{Object.entries(layers).map(([key,val])=><label key={key} className="layer-toggle"><span>{({routes:'Route guidance',labels:'Location names',shelves:'Interactive shelves',grid:'Dot grid',sensors:'Sensor coverage',obstacles:'Obstacles'})[key]}</span><input type="checkbox" checked={val} onChange={e=>setLayers(old=>({...old,[key]:e.target.checked}))}/><i/></label>)}</div>}
    </div>}
    <div className="map-frame"><StoreMap s={s} view={view} layers={layers} zoom={zoom} onNode={id=>onAction('node',id)} onShelf={id=>onAction('select_shelf',id)}/>
      <div className="zoom-controls"><IconButton Icon={Plus} title="Zoom in" onClick={()=>setZoom(z=>Math.min(1.7,z+.15))}/><IconButton Icon={LocateFixed} title="Reset zoom" onClick={()=>setZoom(1)}/><IconButton Icon={Minus} title="Zoom out" onClick={()=>setZoom(z=>Math.max(.75,z-.15))}/></div>
    </div>
    <div className="map-footer"><div className="route-summary"><span className="route-symbol"><Route size={17}/></span><div><Eyebrow>PLANNED ROUTE</Eyebrow><strong>{(s?.route||[]).map(id=>getNode(s,id)?.label||id).join(' / ')||'Awaiting destination'}</strong></div></div>
      <div className="route-stat"><span>DISTANCE LEFT</span><b>{NUM(s?.route_distance)} <small>m</small></b></div></div>
  </section>;
}

function StatsRow({s}){
  const n=s?.metrics||{}, total=s?.goals?.length||0, completed=(s?.goals||[]).filter(g=>g.status==='found').length;
  const stats=[{label:'Distance travelled',value:NUM(n.distance),unit:'m',Icon:Footprints,sub:'Total walked distance'},
    {label:'Items collected',value:completed,unit:`/ ${total}`,Icon:Package,sub:'Verified shopping goals'},
    {label:'Safety alerts',value:n.alerts||0,unit:'',Icon:ShieldAlert,sub:`${n.reroutes||0} route adjustments`},
    {label:'Basket total',value:MONEY(s?.cart_total),unit:'',Icon:ShoppingBag,sub:`${s?.cart?.length||0} products in basket`}];
  return <div className="stat-row">{stats.map((m,i)=><div className="stat-tile" key={m.label}><div className="stat-tile-top"><span>{m.label}</span><m.Icon size={17}/></div><div className="stat-number">{m.value}<small>{m.unit}</small></div><div className="stat-description">{m.sub}</div>{i===3&&<span className="stat-decoration"/>}</div>)}</div>;
}

function MissionPanel({s,onAction,openShelves}){
  const goals=s?.goals||[],found=goals.filter(g=>g.status==='found').length,done=goals.filter(g=>g.status!=='pending').length, all=goals.length||1;
  const here=getNode(s,s?.goal?.node)?.label||s?.goal?.node||'—';
  const current=s?.goal?.name||'Loading mission';
  return <section className="surface mission-panel"><div className="mission-top"><div><Eyebrow>YOUR MISSION</Eyebrow><h2>Current objective</h2></div><div className="mission-target-number"><Target size={17}/></div></div>
      <div className="objective-number">OBJECTIVE {String(Math.min(done+1,all)).padStart(2,'0')} <span>/ {String(all).padStart(2,'0')}</span></div>
      <h3>{current}</h3><p className="mission-aisle"><MapPinned size={15}/>{here}</p>
      <div className="mission-progress"><div className="mission-progress-copy"><b>Journey progress</b><span>{done} of {all} resolved</span></div><Progress value={100*done/all}/></div>
      <button className="primary-button mission-navigate" disabled={!s?.goal||s.state==='COMPLETE'||!!s.product_detour} onClick={()=>onAction('route_to_goal')}><Navigation2 size={17}/> Show shortest route</button>
      <div className="mission-divider"/>
      <div className="control-title"><Eyebrow>SIMULATION CONTROLS</Eyebrow><span>{s?.product_detour?'PRODUCT DETOUR':s?.mode==='AUTO'?'AUTOPILOT':s?.mode==='GUIDED'?'GUIDED':'MANUAL'}</span></div>
      <div className="control-mode">{[['FREE','Manual'],['GUIDED','Guided'],['AUTO','Auto']].map(([value,label])=><button key={value} className={s?.mode===value?'on':''} onClick={()=>onAction('mode',value)}>{label}</button>)}</div>
      <div className="control-primary"><button className="control-main" onClick={()=>onAction('walk')}><span>{s?.walking?<Pause size={19}/>:<Play size={19} fill="currentColor"/>}</span>{s?.walking?'Pause movement':'Start walking'}</button><button className="control-alt" title="Stop" onClick={()=>onAction('stop')}><span className="stop-square"/></button></div>
      <div className="control-shortcuts"><button disabled={!!s?.product_detour} onClick={()=>onAction('scan')}><ScanLine size={17}/> Scan</button><button onClick={()=>onAction('reverse')}><RotateCcw size={17}/> U-turn</button><button onClick={()=>onAction('obstacle')}><AlertTriangle size={17}/> Obstacle</button></div>
      <div className="direction-row"><span>AVAILABLE PATHS</span>{(s?.choices||[]).length?<div>{(s?.choices||[]).slice(0,3).map(c=><button key={c.key} disabled={c.blocked} onClick={()=>onAction('option',c.key)} title={c.name}><kbd>{c.key}</kbd><span>{c.name}</span></button>)}</div>:<small>None at this location</small>}</div>
      <button className="mission-footer" onClick={openShelves}><ShoppingBag size={17}/> Explore products beyond your list <ArrowRight size={15}/></button>
    </section>;
}

function ProductDetourPanel({s,onAction}){
  const detour=s?.product_detour;
  if(!detour)return null;
  const {sku_id,name,aisle,shelf_id,status,stock,price}=detour;
  const arrived=status==='arrived';
  const statusText=({arrived:'At shelf',blocked:'Route blocked'})[status]||`${NUM(s.route_distance)} m to shelf`;
  return <section className="surface product-detour" aria-label="Extra product detour">
    <div className="panel-heading-label">
      <div className="panel-icon"><Navigation2 size={19}/></div>
      <div><Eyebrow>EXTRA PRODUCT</Eyebrow><h2>{name}</h2><p>{getNode(s,aisle)?.label||aisle} · {shelf_id.endsWith('_L')?'Left':'Right'} rack</p></div>
    </div>
    <Pill type={arrived?'success':status==='blocked'?'danger':'accent'}>{statusText}</Pill>
    <div className="product-detour-actions">
      {arrived&&stock>0&&(s.selected_shelf?.id===shelf_id?
        <button className="primary-button" onClick={()=>onAction('buy',{sku_id,quantity:1})}><Plus size={16}/> Add to basket · {MONEY(price)}</button>:
        <button className="primary-button" onClick={()=>onAction('select_shelf',shelf_id)}><Store size={16}/> Show rack</button>)}
      {status==='ready'&&<button className="primary-button" onClick={()=>onAction('walk')}><Play size={16}/> Walk next corridor</button>}
      {status==='en_route'&&<button className="secondary-button" onClick={()=>onAction('walk')}><Pause size={16}/> Pause walking</button>}
      <button className="secondary-button" onClick={()=>onAction('resume_list')}><ListChecks size={16}/> Resume shopping list</button>
    </div>
  </section>;
}

function ScanPurchasePrompt({purchase,onAction}){
  const ref=useRef(null);
  const open=!!purchase;
  useEffect(()=>{
    const dialog=ref.current;
    if(open&&!dialog.open)dialog.showModal();
    if(!open&&dialog.open)dialog.close();
  },[open]);
  const dismiss=()=>onAction('dismiss_scan',purchase?.sku_id);
  return <dialog ref={ref} className="surface scan-purchase" aria-labelledby="scan-purchase-title" aria-describedby="scan-purchase-description"
    onCancel={e=>{e.preventDefault();dismiss()}} onKeyDown={e=>e.stopPropagation()}>
    {purchase&&<>
      <div className="panel-heading-label"><div className="panel-icon"><CheckCircle2 size={20}/></div><h2 id="scan-purchase-title">Item found</h2></div>
      <p id="scan-purchase-description">Add <strong>{purchase.name}</strong> to your basket for {MONEY(purchase.price)}?</p>
      <div className="scan-purchase-actions">
        <button className="secondary-button" onClick={dismiss} autoFocus>Not now</button>
        <button className="primary-button" onClick={()=>onAction('confirm_scan',purchase.sku_id)}><Plus size={16}/> Add to basket</button>
      </div>
    </>}
  </dialog>;
}

function InventoryProduct({p,index,reachable,finished,onBuy,qty=1,full=false,onQuantityChange}){
  const buyable=reachable&&!p.restricted&&p.stock>0&&!finished;
  return <article className={'inventory-product'+(full?' inventory-product-full':'')}>
    <div className={'product-art art-'+index%6}><div className="product-art-frame"><Package size={full?27:22} strokeWidth={1.5}/></div><span>{p.family||'PRODUCT'}</span></div>
    <div className="product-copy"><div className="product-tags"><span className={p.in_list?'tag-list':'tag-extra'}>{p.in_list?'ON YOUR LIST':'DISCOVER'}</span>{p.restricted&&<span className="tag-alert">RESTRICTED</span>}</div>
       <h4>{p.name}</h4><p>{p.stock?`${p.stock} available`:'Out of stock'}{p.in_cart?` · ${p.in_cart} in basket`:''}</p>
       {!!p.allergens?.length&&<small className="allergen-note">Allergens: {p.allergens.join(', ')}</small>}
       <div className="product-bottom"><strong>{MONEY(p.price)}</strong>
         <div className="product-actions">{full&&<select disabled={!buyable} value={Math.max(1,Math.min(qty,p.stock||1))} aria-label={`Quantity for ${p.name}`} onChange={e=>onQuantityChange(p.id,Number(e.target.value))}>{Array.from({length:Math.min(12,p.stock)},(_,i)=><option key={i+1} value={i+1}>{i+1}</option>)}</select>}
         <button disabled={!buyable} title={!reachable?'Visit this shelf to collect items':p.restricted?'Blocked by selected allergen profile':!p.stock?'Out of stock':'Add product to basket'} onClick={()=>onBuy(p.id,full?Math.max(1,Math.min(qty,p.stock)):1)}>{buyable&&<Plus size={14}/>}<span>{!reachable?'Visit aisle':p.restricted?'Restricted':!p.stock?'Sold out':'Add'}</span></button></div>
       </div>
    </div></article>;
}

function ShelfPeek({s,onAction,openShelves}){
  const shelf=s?.selected_shelf||{},products=shelf.items||[];
  const detourToShelf=!!s?.product_detour&&s.product_detour.shelf_id===shelf.id;
  return <section className="surface shelf-peek"><Titlebar kicker="STORE INVENTORY" title="Shelf spotlight" action={<button className="link-button" onClick={openShelves}>Open browser <ArrowUpRight size={15}/></button>}/>
    <div className="shelf-selected-summary"><div className="shelf-symbol"><Store size={20}/></div><div><span>CURRENTLY INSPECTING</span><strong>{shelf.label||'Select a shelf'} · {shelf.side||'Left'} rack</strong><small>{products.length} unique products</small></div><Pill type={shelf.reachable?'success':'neutral'}>{shelf.reachable?'Nearby':'Preview'}</Pill></div>
    {!shelf.reachable&&!detourToShelf&&<button className="visit-shelf" onClick={()=>onAction('visit_shelf',shelf.id)} disabled={!shelf.id}><Navigation2 size={15}/> Walk to this shelf <ArrowRight size={14}/></button>}
    <div className="peek-products">{products.slice(0,3).map((p,i)=><InventoryProduct key={p.id} p={p} index={i} reachable={shelf.reachable} finished={s?.state==='COMPLETE'} onBuy={(id,quantity)=>onAction('buy',{sku_id:id,quantity})}/>)}</div>
    {products.length>3&&<button className="peek-more" onClick={openShelves}>View {products.length-3} more products <ArrowRight size={14}/></button>}
  </section>;
}

function SensorPanel({s}){
  const sen=s?.sensors||{},v=Math.max(0,Number(sen.fused||0)),threshold=Number(sen.threshold||1.2);
  const measurements=[{title:'RGB-D depth',value:sen.rgbd,max:6},{title:'Time-of-flight',value:sen.tof,max:4},{title:'Monocular',value:sen.mono,max:9}];
  return <section className="surface sensor-panel"><Titlebar kicker="PERCEPTION SYSTEM" title="Sensor fusion" action={<Pill type={sen.hazard?'danger':'neutral'} Icon={sen.hazard?AlertTriangle:Radar}>{sen.hazard?'Hazard detected':'Monitoring'}</Pill>}/>
    <div className="distance-hero"><div className="distance-ring" style={{'--arc':`${Math.min(100,v/6*100)}%`}}><div><b>{NUM(v,2)}</b><small>METERS</small></div></div><div className="distance-overview"><span>FUSED PROXIMITY</span><h3>{sen.hazard?'Unsafe proximity':sen.detected?'Object detected':'Clear ahead'}</h3><p>Conservative minimum-distance estimate across simulated sensors.</p></div></div>
    <div className="sensor-measurements">{measurements.map(x=><div key={x.title} className="measurement"><div><span>{x.title}</span><b>{NUM(x.value,2)} <small>m</small></b></div><div className="measurement-track"><i style={{width:`${Math.max(0,Math.min(100,(x.value||0)/x.max*100))}%`}}/></div></div>)}</div>
    <div className="sensor-hint"><Info size={14}/> Illustrated sensor data · {NUM(threshold,1)}m safety threshold</div>
  </section>;
}

function Telemetry({s}){
  const arr=(s?.history||[]).slice(-80), values=arr.length?arr.map(v=>v.range):[4,4,4];const X=i=>36+520*i/Math.max(1,values.length-1),Y=v=>173-(Math.max(0,Math.min(6,Number(v||0)))/6)*138;
  const path=values.map((v,i)=>`${i?'L':'M'}${X(i)} ${Y(v)}`).join(' ');
  return <section className="surface telemetry-panel"><Titlebar kicker="DISTANCE OVER TIME" title="Live telemetry" action={<Pill Icon={Activity} type="neutral">Live feed</Pill>}/>
    <div className="graph-wrap"><svg viewBox="0 0 580 214" preserveAspectRatio="none" role="img" aria-label="Live proximity range chart">
      {[0,2,4,6].map(v=><g key={v}><line x1="36" x2="565" y1={Y(v)} y2={Y(v)} className="chart-grid"/><text x="8" y={Y(v)+4} className="chart-axis">{v}m</text></g>)}
      <path d={`${path} L${X(values.length-1)} 173 L36 173 Z`} className="chart-area"/>
      <path d={path} className="chart-line"/>
      <line x1="36" x2="565" y1={Y(1.2)} y2={Y(1.2)} className="chart-threshold"/>
      <text x="36" y="202" className="chart-axis">EARLIER</text><text x="565" y="202" textAnchor="end" className="chart-axis">NOW · {TIME(s?.time)}</text>
    </svg></div>
    <div className="graph-legend"><span><i className="chart-swatch"/> Fused distance</span><span><i className="chart-swatch warning"/> Safety threshold</span></div>
  </section>;
}

function PlannerPanel({s,onAction}){
  const data=s?.planner||{},comparison=s?.comparisons||[],max=Math.max(...comparison.map(x=>x.cost),1);
  return <section className="surface planner-panel"><Titlebar kicker="ROUTING ENGINE" title="Path analysis" action={<GitBranch size={18} className="muted-icon"/>}/>
    <label className="form-label">ROUTING ALGORITHM<select className="studio-select" value={data.name||'Dijkstra'} onChange={e=>onAction('planner',e.target.value)}><option>Dijkstra</option><option>A*</option><option>BFS</option></select></label>
    <div className="planner-kpis"><div><span>ROUTE COST</span><b>{NUM(data.cost)} <small>m</small></b></div><div><span>VISITED</span><b>{data.visited||0}</b></div><div><span>TIME</span><b>{NUM(data.runtime_us)} <small>μs</small></b></div></div>
    <div className="planner-compare"><span>ALGORITHM COMPARISON</span>{comparison.map(d=><button key={d.name} className={d.name===data.name?'active':''} onClick={()=>onAction('planner',d.name)}><b>{d.name}</b><span><i style={{width:`${Math.max(6,d.cost/max*100)}%`}}/></span><small>{NUM(d.cost)}m</small></button>)}</div>
    <p className="planner-note"><Info size={13}/> Synthetic small graph; timings are not performance benchmarks.</p>
  </section>;
}

function ActivityFeed({s,limit=8}){
  const events=(s?.events||[]).filter(e=>e.type!=='voice').slice(0,limit);
  return <section className="surface activity-panel"><Titlebar kicker="SIMULATION LOG" title="Recent activity" action={<Pill>{(s?.events||[]).length} events</Pill>}/>
    <div className="activity-list">{events.length?events.map((e,i)=>{const I=EVENT_ICONS[e.type]||Activity;
      return <div key={`${e.t}-${i}`} className="activity-item"><div className={'activity-marker '+colorType(e.type)}><I size={15}/></div><div className="activity-content"><strong>{e.type==='start'?'Session initialized':e.type==='scan'?'Product scan':TITLE(e.type)}</strong><p>{e.msg}</p></div><time>{TIME(e.t)}</time></div>
    }):<div className="empty-state"><Activity size={25}/> Events appear here as you navigate.</div>}</div>
  </section>;
}

function Basket({s}){
  const grouped=Object.values((s?.cart||[]).reduce((acc,x)=>{if(!acc[x.id])acc[x.id]={...x,qty:0};acc[x.id].qty+=1;return acc;},{}));
  return <section className="surface basket-panel"><Titlebar kicker="SHOPPING BASKET" title="Your basket" action={<Pill Icon={ShoppingBag}>{s?.cart?.length||0} items</Pill>}/>
    <div className="basket-rows">{grouped.length?grouped.map(p=><div key={p.id} className="basket-row"><div className="basket-product-icon"><Package size={16}/></div><div><strong>{p.name}</strong><small>{p.qty} × {MONEY(p.price)}</small></div><b>{MONEY(p.qty*p.price)}</b></div>):<div className="empty-basket"><ShoppingBag size={26}/><strong>Nothing in your basket yet</strong><p>Browse shelves or scan your shopping list to add products.</p></div>}</div>
    <div className="basket-total"><span>Estimated total</span><strong>{MONEY(s?.cart_total)}</strong></div>
  </section>;
}

function ShelfBrowser({s,onAction,openFullBrowser}){
  const shelves=s?.shelves||[],selected=s?.selected_shelf||{};
  const [query,setQuery]=useState(''),[quantities,setQuantities]=useState({});
  const detour=s?.product_detour;
  const detourToShelf=detour&&detour.shelf_id===selected.id;
  const products=(selected.items||[]).filter(p=>`${p.name} ${p.family}`.toLowerCase().includes(query.trim().toLowerCase()));
  if(detourToShelf)products.sort((a,b)=>Number(b.id===detour.sku_id)-Number(a.id===detour.sku_id));
  const search=<label className="catalog-search"><Search size={17}/><input placeholder="Search this shelf..." value={query} onChange={e=>setQuery(e.target.value)} aria-label="Search shelf inventory"/></label>;
  const inventory=<div className="catalog-grid">
    {products.map((p,i)=><InventoryProduct full key={p.id} p={p} index={i} reachable={selected.reachable} finished={s?.state==='COMPLETE'} qty={quantities[p.id]||1} onQuantityChange={(id,qty)=>setQuantities(q=>({...q,[id]:qty}))} onBuy={(id,quantity)=>onAction('buy',{sku_id:id,quantity})}/>)}
    {!products.length&&<div className="empty-state">{selected.id?'No matching products on this shelf.':'Waiting for shelf inventory.'}</div>}
  </div>;

  if(openFullBrowser)return <aside className="surface shelf-quick" aria-label="Shelf browser">
    <div className="shelf-quick-heading"><h2><Store size={18}/> Shelf browser</h2><button type="button" className="link-button" onClick={openFullBrowser}>Full browser</button></div>
    <div className="shelf-quick-rack">
      <select className="studio-select" aria-label="Choose a shelf rack" value={selected.id||''} disabled={!shelves.length} onChange={e=>onAction('select_shelf',e.target.value)}>
        <option value="" disabled>Choose a shelf rack</option>
        {shelves.map(sh=><option key={sh.id} value={sh.id}>{sh.label}</option>)}
      </select>
      <ChevronDown size={16} aria-hidden="true"/>
    </div>
    <div className="shelf-quick-actions">{selected.reachable?<Pill type="success" Icon={MapPinned}>At this aisle</Pill>:detourToShelf?
      <Pill type="accent" Icon={Route}>Detour rack</Pill>:
      <button type="button" className="secondary-button" disabled={!selected.id} onClick={()=>onAction('visit_shelf',selected.id)}><Navigation2 size={15}/> Walk to shelf</button>}
      {search}
    </div>
    <div className="shelf-quick-products" role="region" aria-label="Products on the selected shelf" tabIndex={0} onKeyDown={e=>e.stopPropagation()}>
      {inventory}
    </div>
  </aside>;

  const grouped=Object.entries(shelves.reduce((acc,sh)=>{(acc[sh.aisle_label] ||= []).push(sh);return acc;},{}));
  return <div className="shelves-layout"><section className="surface rack-directory"><Titlebar kicker="STORE DIRECTORY" title="All shelves" action={<Pill>{shelves.length} racks</Pill>}/>
     <div className="rack-directory-inner">{grouped.map(([aisle,items])=><div key={aisle} className="rack-group"><div className="rack-group-title">{aisle}</div><div className="rack-group-items">{items.map(sh=><button key={sh.id} aria-pressed={selected.id===sh.id} className={'rack-choice'+(selected.id===sh.id?' selected':'')} onClick={()=>onAction('select_shelf',sh.id)}><span><Boxes size={16}/>{sh.side} rack</span><small>{sh.count} items</small><Check size={15} className="rack-check" aria-hidden="true"/></button>)}</div></div>)}</div>
   </section>
   <div className="shelf-browser-main"><section className="surface shelf-catalog"><div className="catalog-hero"><div><Eyebrow>SELECTED STORE SECTION</Eyebrow><h2>{selected.label||'Choose a shelf'}</h2><p>{selected.side} rack · {selected.items?.length||0} products · {selected.reachable?'You are at this aisle':'Remote browsing mode'}</p></div><div className="catalog-hero-icon"><Store size={35}/></div></div>
      {!selected.reachable&&!detourToShelf&&<div className="catalog-visit"><div><Navigation2 size={19}/><span><strong>Want to pick something up?</strong><small>Browse remotely, then navigate to the aisle to collect.</small></span></div><button className="primary-button" onClick={()=>onAction('visit_shelf',selected.id)} disabled={!selected.id}>Walk to shelf <ArrowRight size={15}/></button></div>}
      <div className="catalog-toolbar"><div className="catalog-count"><b>{products.length}</b> products on this shelf</div>{search}</div>
      {inventory}
    </section><Basket s={s}/></div>
  </div>;
}

function VisionLab({s,onAction}){
  const scan=s?.scan, detections=scan?.detections||[];
  return <div className="vision-layout"><section className="surface vision-panel"><Titlebar kicker="COMPUTER VISION" title="Recognition workspace" action={<Pill Icon={ScanLine} type="accent">SIMULATED CAMERA</Pill>}/>
    <div className="camera-feed"><div className="camera-lines"><i/><i/><i/><i/></div><div className="camera-header"><span className="live-point"/> CAM / 001 <span>DEMO VISUALIZATION</span></div>
      <div className="camera-shelves"><div className="camera-rack">{Array.from({length:6},(_,i)=><div className={'camera-product c-'+i} key={i}><span/><b>{['MILK','RICE','FRUIT','OATS','TEA','FRESH'][i]}</b><i/></div>)}</div><div className="camera-board"/><div className="camera-rack bottom">{Array.from({length:6},(_,i)=><div className={'camera-product c-'+((i+3)%6)} key={i}><span/><b>{['SELECT','GRAIN','NUTRI','FRESH','BLEND','LOCAL'][i]}</b><i/></div>)}</div><div className="camera-board"/></div>
      {detections.map((d,i)=><div key={i} className={'detected-region'+(d.selected?' detection-selected':'')} style={{left:`${d.box[0]*100}%`,top:`${d.box[1]*100}%`,width:`${d.box[2]*100}%`,height:`${d.box[3]*100}%`}}><span>{d.name}</span><b>{Math.round(d.score*100)}%</b></div>)}
      {!scan&&<div className="camera-no-scan"><ScanLine size={40}/><b>No scan captured</b><p>Navigate to the target shelf and run a scan to inspect simulated detections.</p><button className="primary-button" onClick={()=>onAction('scan')}>Run shelf scan <ArrowRight size={15}/></button></div>}
      <div className="camera-bottomline"><span>MONITORING · {s?.lighting?.toUpperCase()||'NORMAL'} LIGHT</span><span>{detections.length} DETECTION REGIONS</span></div>
    </div><div className={'vision-results'+(scan?' has-scan':'')}><div><span>RECOGNITION RESULT</span><strong>{scan?TITLE(scan.outcome):'Awaiting scan'}</strong></div><div><span>CONFIDENCE</span><strong>{scan?`${Math.round(scan.score*100)}%`:'—'}</strong></div><div><span>THRESHOLD</span><strong>75%</strong></div>{scan&&<button className="primary-button" onClick={()=>onAction('scan')}><ScanLine size={16}/> Run scan</button>}</div>
  </section><div className="vision-side"><section className="surface"><Titlebar kicker="MODEL EXPLANATION" title="About this simulation"/><div className="explain-copy"><Info size={22}/><p>The vision panel uses synthetic bounding boxes and confidence values from the native C++ demonstrator. It is <strong>not a live camera feed or real CAQE inference</strong>.</p></div><div className="readout-line"><span>Recognition mode</span><b>Simulated SKU match</b></div><div className="readout-line"><span>Lighting</span><b>{s?.lighting||'normal'}</b></div><div className="readout-line"><span>Scan attempts</span><b>{s?.metrics?.scans||0}</b></div></section><SensorPanel s={s}/></div></div>;
}

function ShoppingList({s,onAction}){
  const goals=s?.goals||[],found=goals.filter(g=>g.status==='found').length;
  return <section className="surface checklist-panel"><Titlebar kicker="TRIP CHECKLIST" title="Shopping objectives" action={<Pill>{found} / {goals.length} found</Pill>}/>
    <div className="checklist">{goals.map(g=><div key={g.id} className={'checklist-item'+(g.active?' is-now':'')}>
      <span className={'checkmark'+(g.status==='found'?' checked':'')}>{g.status==='found'&&<Check size={13}/>}</span>
      <div><strong>{g.name}</strong><small>{getNode(s,g.node)?.label||g.node}{g.active&&<span className="now-label">NEXT</span>}</small></div><b>{MONEY(g.price)}</b>
      {onAction&&<span className="checklist-action">{g.status==='pending'&&<IconButton Icon={Route} title={`Show route to ${g.name}`} onClick={()=>onAction('request_product',g.id)}/>}</span>}
    </div>)}</div>
  </section>;
}

function SettingsPanel({s,onAction,onClose}){
  const selects=[{label:'Store layout',name:'map',value:s?.map||'standard',opts:(s?.options?.maps||[]).map(m=>({value:m.id,label:m.label}))},
    {label:'Shopping scenario',name:'list',value:s?.list||'Everyday Essentials',opts:(s?.options?.lists||[]).map(x=>({value:x,label:x}))},
    {label:'Accessibility profile',name:'profile',value:s?.profile||'Default',opts:(s?.options?.profiles||[]).map(x=>({value:x,label:x}))},
    {label:'Lighting',name:'lighting',value:s?.lighting||'normal',opts:[{value:'normal',label:'Normal'},{value:'bright',label:'Bright'},{value:'dim',label:'Dim'}]},
    {label:'Playback speed',name:'speed',value:s?.speed||1,opts:[.5,1,2,4].map(x=>({value:x,label:`${x}× speed`}))}];
  const obstaclesEnabled=Boolean(s?.chaos);
  return <section id="simulation-settings" className="surface settings-panel" aria-labelledby="simulation-settings-title">
    <div className="settings-header">
      <div className="panel-heading-label">
        <div className="panel-icon"><Settings2 size={19}/></div>
        <h2 id="simulation-settings-title">Simulation configuration</h2>
      </div>
      <IconButton Icon={X} title="Close settings" onClick={onClose}/>
    </div>
    <div className="settings-grid">
      {selects.map(({label,name,value,opts})=><label key={name} className="settings-field">
        <span>{label}</span>
        <span className="settings-select">
          <select className="studio-select" value={value} onChange={e=>onAction(name,name==='speed'?Number(e.target.value):e.target.value)}>
            {opts.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <ChevronDown size={16} aria-hidden="true"/>
        </span>
      </label>)}
      <div className="settings-field">
        <span id="settings-obstacles-label">Dynamic obstacles</span>
        <button type="button" className="settings-switch" role="switch" aria-checked={obstaclesEnabled}
          aria-labelledby="settings-obstacles-label" title="Random moving and static hazards" onClick={()=>onAction('chaos',!obstaclesEnabled)}>
          <span aria-hidden="true">{obstaclesEnabled?'On':'Off'}</span><span className="settings-switch-track" aria-hidden="true"/>
        </button>
      </div>
    </div>
  </section>;
}

function App(){
  const [s,setS]=useState(null),[error,setError]=useState(''),[page,setPage]=useState('Overview');
  const [view,setView]=useState('floor'),[layers,setLayers]=useState(DEFAULT_LAYERS),[zoom,setZoom]=useState(1),[settingsOpen,setSettingsOpen]=useState(false);
  const [theme,setTheme]=useState(()=>{try{return localStorage.getItem('saarathi-studio-theme')||'dark'}catch{return 'dark'}});
  const [voiceEnabled,setVoiceEnabled]=useState(false),[micEnabled,setMicEnabled]=useState(false),[command,setCommand]=useState(''),[toast,setToast]=useState('');
  const [assistantReply,setAssistantReply]=useState('');
  const speaking=useRef(''),busy=useRef(false),settingsTrigger=useRef(null);
  useEffect(()=>{document.documentElement.dataset.theme=theme;try{localStorage.setItem('saarathi-studio-theme',theme)}catch{}},[theme]);
  useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(''),3500);return()=>clearTimeout(timer)},[toast]);
  const refresh=useCallback(async()=>{try{setS(await readState());setError('')}catch{setError(engineError)}},[]);
  useEffect(()=>{refresh();const t=setInterval(refresh,250);return()=>clearInterval(t)},[refresh]);
  const act=useCallback(async(action,value=null)=>{
    if(busy.current)return;
    busy.current=true;
    try{
      const data=await sendAction(action,value);
      setS(data);setError('');setAssistantReply('');
      if(action==='request_product'||action==='route_to_goal')setLayers(l=>l.routes?l:{...l,routes:true});
      return data;
    }catch(e){
      if(action==='request_product'){
        const outdatedBackend=/^Unsupported action:\s*request_product$/.test(e.message);
        setAssistantReply(outdatedBackend?'Restart the simulator to load the backend that supports product requests.':e.message||'Could not find that product.');
      }
      else setToast(e.message||'Action failed');
    }finally{busy.current=false}
  },[]);
  const downloadSession=async()=>{
    try{
      const url=URL.createObjectURL(await exportSession());
      const link=document.createElement('a');
      link.href=url;
      link.download='saarathi_simulation.json';
      link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(e){setToast(e.message||'Unable to export the session.')}
  };
  useEffect(()=>{if(!voiceEnabled||!s?.last_speech||speaking.current===s.last_speech)return;speaking.current=s.last_speech;if(!('speechSynthesis'in window))return;window.speechSynthesis.cancel();const utterance=new SpeechSynthesisUtterance(s.last_speech);utterance.rate=1.05;window.speechSynthesis.speak(utterance)},[voiceEnabled,s?.last_speech]);
  useEffect(()=>{const key=e=>{if(['INPUT','SELECT','TEXTAREA','BUTTON'].includes(e.target?.tagName)||e.target?.isContentEditable)return;
    if(e.code==='Space'){e.preventDefault();act('walk')}else if(e.key.toLowerCase()==='s')act('scan');else if(e.key.toLowerCase()==='u')act('reverse');else if(e.key.toLowerCase()==='o')act('obstacle');else if(e.key.toLowerCase()==='r')act('reset');else if(/^[1-9]$/.test(e.key))act('option',Number(e.key));
    else if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();act('steer',({ArrowUp:[0,-1],ArrowDown:[0,1],ArrowLeft:[-1,0],ArrowRight:[1,0]})[e.key]);}
  };window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key)},[act]);
  const submitCommand=async(text=command)=>{
    const t=text.trim().toLowerCase();
    if(!t)return;
    setCommand('');setAssistantReply('');
    const product=productRequest(text);
    const nodes=s?.layout?.nodes||[];
    const namedAisle=t.startsWith('where ')&&product&&nodes.find(n=>n.label.toLowerCase()===product.toLowerCase()||n.id.toLowerCase().replace('_',' ')===product.toLowerCase());
    if(namedAisle)return act('node',namedAisle.id);
    if(product===null){
      if(/^(?:resume|continue|back to)\s+(?:(?:my|the)\s+)?(?:shopping\s+)?list[.!?]*$/.test(t))return act('resume_list');
      if(t.includes('scan'))return act('scan');
      if(t.includes('stop'))return act('stop');
      if(t.includes('pause'))return s?.product_detour?act('pause_detour'):act('stop');
      if(t.includes('back'))return act('reverse');
      if(t.includes('walk')||t.includes('start')||t.includes('continue'))return act('walk');
      if(t.includes('obstacle'))return act('obstacle');
      if(t.includes('reset'))return act('reset');
      if(t.includes('auto'))return act('mode','AUTO');
      const node=nodes.find(n=>t.includes(n.label.toLowerCase())||t.includes(n.id.toLowerCase().replace('_',' ')));
      if(node)return act('node',node.id);
    }
    const data=await act('request_product',product??text.trim());
    if(data&&page!=='Overview'&&page!=='Navigation')goPage('Overview');
  };
  const toggleMic=()=>{
    const Recognizer=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!Recognizer){setToast('Voice recognition is unavailable in this browser.');return}
    if(micEnabled)return;
    const r=new Recognizer();r.lang='en-IN';r.continuous=false;
    r.onresult=e=>{
      const transcript=e.results[0][0].transcript;
      setMicEnabled(false);
      if(productRequest(transcript)!==null)submitCommand(transcript);else setCommand(transcript);
    };
    r.onerror=()=>{setMicEnabled(false);setToast('Microphone recognition unavailable.')};
    r.onend=()=>setMicEnabled(false);
    setMicEnabled(true);r.start();
  };
  const goPage=key=>{setPage(key);setSettingsOpen(false);if(key==='Navigation')setView('graph');else if(key==='Overview')setView('floor')};
  const toggleSettings=e=>{settingsTrigger.current=e.currentTarget;setSettingsOpen(open=>!open)};
  const closeSettings=()=>{setSettingsOpen(false);settingsTrigger.current?.focus()};
  const pageTitle=({Overview:'Mission control.',Navigation:'Map explorer',Shelves:'Shelf browser','Vision lab':'Vision laboratory',Telemetry:'System analytics','Activity log':'Activity timeline'})[page];
  const pageDescription=({Overview:'Your live indoor navigation experiment, all in one place.',Navigation:'Analyze routes, traffic and sensor coverage across the store.',Shelves:'Discover what is on each shelf and shop beyond your list.','Vision lab':'Inspect synthetic product recognition and scan diagnostics.',Telemetry:'Real-time perception, routing and journey measurements.','Activity log':'A transparent record of simulation events and decisions.'})[page];
  const currentMap=s?.options?.maps?.find(m=>m.id===s?.map)?.label||'Classic market';
  return <div className="app-shell">
    <aside className="app-sidebar">
      <button className="brand-lockup" onClick={()=>goPage('Overview')} aria-label="Saarathi studio home"><span className="brand-monogram"><Waypoints size={25}/></span><span className="brand-name"><strong>saarathi<span>.</span></strong><small>NAVIGATION STUDIO</small></span></button>
      <div className="sidebar-rule"/><div className="sidebar-label">WORKSPACE</div>
      <nav className="sidebar-nav" aria-label="Main navigation">{NAV.map(n=><button key={n.id} aria-current={page===n.id?'page':undefined} className={'nav-link'+(page===n.id?' selected':'')} onClick={()=>goPage(n.id)}><n.Icon size={19} strokeWidth={1.8}/><span>{n.label}</span>{page===n.id&&<ChevronRight size={15} className="nav-chevron"/>}</button>)}</nav>
      <div className="sidebar-label sidebar-label-second">TOOLS</div><button className={'nav-link sidebar-settings'+(settingsOpen?' selected':'')} aria-expanded={settingsOpen} aria-controls="simulation-settings" onClick={toggleSettings}><Settings2 size={19}/><span>Experiment setup</span></button>
      <div className="sidebar-spacer"/>
      <div className="sidebar-session"><div className="session-art"><Radar size={22}/><span className="session-art-dot"/></div><div><small>ACTIVE SIMULATION</small><b>Session {String(s?.session||1).padStart(3,'0')}</b></div></div>
      <div className="sidebar-engine"><span className={'status-dot'+(error?' error':'')}/><span>{error?'Engine disconnected':'C++ engine connected'}</span><span className="sidebar-version">v3.0</span></div>
    </aside>
    <div className="app-body"><header className="app-topbar"><div className="breadcrumbs"><span>Studio</span><ChevronRight size={15}/><b>{page}</b></div><div className="topbar-actions"><span className="topbar-session"><span className="status-dot"/> LIVE SESSION <b>{TIME(s?.time)}</b></span><button className="theme-button" onClick={()=>setTheme(t=>t==='dark'?'light':'dark')} title={`Switch to ${theme==='dark'?'light':'dark'} mode`}>{theme==='dark'?<Sun size={17}/>:<Moon size={17}/>}<span>{theme==='dark'?'Light mode':'Dark mode'}</span></button><IconButton Icon={RefreshCw} title="Reset session" onClick={()=>act('reset')}/><button className="download-button" aria-label="Export session" onClick={downloadSession}><Download size={16}/><span>Export</span></button></div></header>
    <main className="main-workspace"><div className="workspace-heading"><div><div className="workspace-eyebrow"><span/> RESEARCH SIMULATOR <span className="eyebrow-slash">/</span> {currentMap.toUpperCase()}</div><h1>{pageTitle}</h1><p>{pageDescription}</p></div><div className="heading-actions"><Pill type={error?'danger':'accent'} Icon={error?AlertCircle:Activity}>{error?'Disconnected':'Simulation active'}</Pill><button className="secondary-button" aria-expanded={settingsOpen} aria-controls="simulation-settings" onClick={toggleSettings}><SlidersHorizontal size={16}/> Configure</button></div></div>
      {error&&<div className="error-banner"><AlertTriangle size={18}/>{error}</div>}
      {settingsOpen&&<SettingsPanel s={s} onAction={act} onClose={closeSettings}/>}
      <section className="assistant-workspace" aria-label="Saarathi assistant">
        <div className="assistant-console">
          <span className="assistant-avatar"><Sparkles size={19}/></span>
          <div className="assistant-message"><span>SAARATHI ASSISTANT</span><strong role="status">{assistantReply||s?.last_speech||'Navigation engine is initializing…'}</strong></div>
          <button className="assistant-toggle" title={voiceEnabled?'Mute speech':'Enable speech'} onClick={()=>{setVoiceEnabled(v=>!v);if(voiceEnabled&&'speechSynthesis'in window)window.speechSynthesis.cancel()}}>{voiceEnabled?<Volume2 size={18}/>:<VolumeX size={18}/>}</button>
          <button className="assistant-toggle" title="Voice input" aria-pressed={micEnabled} onClick={toggleMic}>{micEnabled?<MicOff size={18}/>:<Mic size={18}/>}</button>
          <form className="assistant-input" onSubmit={e=>{e.preventDefault();submitCommand()}}>
            <input placeholder="Try ‘I want instant coffee’" value={command} onChange={e=>setCommand(e.target.value)} aria-label="Ask for a product or enter a navigation command"/>
            <button type="submit" title="Send command"><ArrowRight size={17}/></button>
          </form>
        </div>
        <ProductDetourPanel s={s} onAction={act}/>
      </section>
      <ScanPurchasePrompt purchase={s?.scan_purchase} onAction={act}/>
      {(page==='Overview'||page==='Navigation')&&<>
        <StatsRow s={s}/>
        <div className={`dashboard-grid ${page==='Overview'?'dashboard-overview':'dashboard-navigation'}`}>
          <MapPanel s={s} onAction={act} view={view} setView={setView} layers={layers} setLayers={setLayers} zoom={zoom} setZoom={setZoom} openShelves={()=>goPage('Shelves')}/>
          {page==='Overview'&&<ShelfBrowser s={s} onAction={act} openFullBrowser={()=>goPage('Shelves')}/>}
          <MissionPanel s={s} onAction={act} openShelves={()=>goPage('Shelves')}/>
          {page==='Navigation'&&<ShelfPeek s={s} onAction={act} openShelves={()=>goPage('Shelves')}/>}
          <ShoppingList s={s} onAction={act}/>
          <div className="dashboard-details">
            <Telemetry s={s}/>
            <SensorPanel s={s}/>
            <PlannerPanel s={s} onAction={act}/>
          </div>
          <ActivityFeed s={s}/>
        </div>
      </>}
      {page==='Shelves'&&<ShelfBrowser s={s} onAction={act}/>}
      {page==='Vision lab'&&<VisionLab s={s} onAction={act}/>}
      {page==='Telemetry'&&<div className="analytics-grid analytics-workspace">
        <Telemetry s={s}/><SensorPanel s={s}/><PlannerPanel s={s} onAction={act}/>
        <section className="surface details-panel"><Titlebar kicker="SESSION PERFORMANCE" title="Cumulative metrics"/>{Object.entries(s?.metrics||{}).map(([k,v])=><div className="readout-line" key={k}><span>{TITLE(k)}</span><b>{v}</b></div>)}</section>
        <ActivityFeed s={s}/>
      </div>}
      {page==='Activity log'&&<div className="analytics-grid"><ActivityFeed s={s} limit={45}/><div><section className="surface details-panel"><Titlebar kicker="EXPERIMENT RECORD" title="Session information"/>{[['Store layout',currentMap],['Planner',s?.planner?.name],['Shopping list',s?.list],['Profile',s?.profile],['Elapsed',TIME(s?.time)],['Simulation core',engineLabel],['Recognition','Synthetic demo']].map(([k,v])=><div className="readout-line" key={k}><span>{k}</span><b>{v||'—'}</b></div>)}<button className="primary-button full-width" onClick={downloadSession}><Download size={16}/> Export session</button></section><ShoppingList s={s}/></div></div>}
      <footer className="footer"><span>SAARATHI / RESEARCH PROTOTYPE</span><span>C++17 Simulation Engine <i/> React Interface <i/> Synthetic Research Data</span></footer>
    </main></div>
    {toast&&<div className="toast" role="status"><Info size={16}/><span>{toast}</span><IconButton Icon={X} title="Dismiss" onClick={()=>setToast('')}/></div>}
  </div>;
}

createRoot(document.getElementById('root')).render(<App/>);
