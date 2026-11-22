#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#include <memory>
#else
#include <boost/asio.hpp>
#include <boost/beast.hpp>
#endif
#include <boost/json.hpp>
#include <boost/json/src.hpp>
#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <iterator>
#include <limits>
#include <map>
#include <mutex>
#include <numeric>
#include <optional>
#include <queue>
#include <random>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <tuple>
#include <utility>
#include <vector>
using namespace std;
#ifndef __EMSCRIPTEN__
namespace asio=boost::asio;
namespace beast=boost::beast;
namespace http=beast::http;
#endif
namespace bj=boost::json;
namespace fs=std::filesystem;
using Clock=chrono::steady_clock;
using Obj=bj::object;
using Arr=bj::array;

static string str(const bj::value&v){return bj::value_to<string>(v);}
static string getstr(const Obj& o,const char*k,const string&fallback="") {auto it=o.find(k);return it==o.end()||!it->value().is_string()?fallback:str(it->value());}
static double getnum(const Obj&o,const char*k,double fallback=0){auto i=o.find(k);if(i==o.end()||!i->value().is_number())return fallback;return i->value().to_number<double>();}
static double rounded(double v,int p=2){if(!isfinite(v))return 0;double k=pow(10,p);return round(v*k)/k;}
static string product_words(const string&text){
  string words;
  bool separator=false;
  for(unsigned char ch:text){
    if(!isalnum(ch)){separator=true;continue;}
    if(!words.empty()&&(separator||bool(isdigit(ch))!=bool(isdigit(static_cast<unsigned char>(words.back())))))words+=' ';
    words+=char(tolower(ch));
    separator=false;
  }
  return words;
}

struct Node {string id,label;double x,y;int products=0;string type="aisle";};
struct Edge {string a,b;double meters,width=2.4;int traffic=0;bool blocked=false;};
struct Product {string id,name,aisle,family;double price;vector<string> allergens;int stock;string shelf;};
struct Goal {int idx;string status="pending";int tries=0;};
struct ProductDetour {int idx;string resume_mode;};
struct Hazard {int id;string a,b,kind,label;double t,ttl,speed,width;bool alerted=false;};
struct RouteResult {vector<string> path;double cost=0;int visited=0;double micros=0;};
struct Event {double at;string type,msg;};
struct Sensor {double rgbd=6,tof=4,mono=6,fused=4,actual=0;string label="";bool detected=false,alert=false;};
static double dist(const Node&a,const Node&b){return hypot(a.x-b.x,a.y-b.y);}

class Engine {
public:
  bj::value dataset;
  vector<Product> skus;
  map<string,vector<string>> shopping;
  map<string,vector<string>> profiles;
  vector<Node> nodes;
  vector<Edge> edges;
  vector<Goal> goals;
  vector<int> cart;
  vector<string> cart_sources;
  vector<int> remaining_stock;
  string selected_shelf_id="Aisle_1_L";
  optional<ProductDetour> detour;
  vector<Hazard> hazards;
  vector<Event> events;
  vector<bj::value> history;
  bj::value scan_state=nullptr;
  int pending_scan=-1;
  string map_id="standard",planner="Dijkstra",mode="FREE",list_name="Everyday Essentials",profile="Default",lighting="normal";
  string node="Entrance",heading="",previous="",destination="",state="NAVIGATING",last_guidance="Ready. Select a destination or begin walking.";
  vector<string> route;
  Sensor sensors;
  RouteResult planned;
  mt19937 rng{7};
  int session=1,seed=7,nearest_goal=-1,next_hazard_id=1,verified=0,skips=0,alerts=0,reroutes=0,scans=0,low_conf=0,allergen_blocks=0,wrong=0;
  double clock=0, progress=0,distance=0,speed=1,tts_acc=0,chaos_acc=0,auto_acc=0;
  bool walking=false,chaos=false,retreating=false,complete=false;
  int map_visits=0;
  vector<string> map_ids={"standard","cross","loop","accessible","compact","superstore"};
  vector<string> algorithms={"Dijkstra","A*","BFS"};
  explicit Engine(bj::value catalogue):dataset(std::move(catalogue)){
    auto& d=dataset.as_object();
    for(auto&v:d.at("skus").as_array()){
      auto&o=v.as_object();Product s{getstr(o,"sku_id"),getstr(o,"name"),getstr(o,"aisle"),getstr(o,"family"),getnum(o,"price_inr"),{},int(getnum(o,"stock",10)),""};
      for(auto&a:o.at("allergens").as_array())s.allergens.push_back(str(a));
      skus.push_back(s);
    }
    map<string,int> positions;
    for(auto&sku:skus)sku.shelf=sku.aisle+((positions[sku.aisle]++%2)==0?"_L":"_R");
    for(auto&kv:d.at("shopping_lists").as_object()){vector<string> items;for(auto&v:kv.value().as_array())items.push_back(str(v));shopping[kv.key().data()]=items;}
    for(auto&kv:d.at("profiles").as_object()){vector<string> allergens;for(auto&v:kv.value().as_object().at("avoid_allergens").as_array())allergens.push_back(str(v));profiles[kv.key().data()]=allergens;}
    reset(false);
  }
  const Node& N(const string&id)const {for(auto&n:nodes)if(n.id==id)return n;throw runtime_error("Unknown node "+id);}
  Edge* E(const string&a,const string&b){for(auto&e:edges)if((e.a==a&&e.b==b)||(e.b==a&&e.a==b))return &e;return nullptr;}
  const Edge* E(const string&a,const string&b)const {for(auto&e:edges)if((e.a==a&&e.b==b)||(e.b==a&&e.a==b))return &e;return nullptr;}
  int product_index(const string&id)const {for(size_t i=0;i<skus.size();i++)if(skus[i].id==id)return int(i);return -1;}
  string shelf_aisle(const string&id)const{
    if(id.size()<3||!((id.compare(id.size()-2,2,"_L")==0||id.compare(id.size()-2,2,"_R")==0)))return "";
    const string aisle=id.substr(0,id.size()-2);
    return has_node(aisle)&&N(aisle).type=="aisle"?aisle:"";
  }
  bool restricted(const Product&p)const{
    const auto&avoid=profiles.at(profile);
    for(auto&a:p.allergens)if(find(avoid.begin(),avoid.end(),a)!=avoid.end())return true;
    return false;
  }
  void log(const string&type,const string&msg){events.push_back({rounded(clock),type,msg});if(events.size()>600)events.erase(events.begin(),events.begin()+150);}
  void say(const string&msg){last_guidance=msg;log("voice",msg);}
  void edge(const string&a,const string&b,double w,double width=2.4,int traffic=0){if(!E(a,b))edges.push_back({a,b,w,width,traffic,false});}
  void point(const string&id,double x,double y,const string&label="",const string&type="junction") {nodes.push_back({id,label.empty()?id:label,x,y,0,type});}
  void build_map(){
    nodes.clear();edges.clear();
    point("Entrance",95,580,"Entrance","entry");point("Checkout",905,580,"Checkout","checkout");
    point("Aisle_1",220,170,"Dairy & Chilled","aisle");point("Aisle_2",500,170,"Rice & Grains","aisle");point("Aisle_3",780,170,"Fresh Produce","aisle");
    point("Aisle_4",220,405,"Breakfast","aisle");point("Aisle_5",500,405,"Cooking & Pantry","aisle");point("Aisle_6",780,405,"Beverages","aisle");
    if(map_id=="compact"){
      for(auto&n:nodes){n.x=140+(n.x-95)*0.78;n.y=145+(n.y-170)*0.79;}
    }else if(map_id=="cross"){
      point("Central_Hub",500,285,"Central crossing");point("North_Hub",500,90,"North corridor");
    }else if(map_id=="loop"){
      point("North_West",95,170,"North-west turn");point("North_East",905,170,"North-east turn");
      point("South_Hub",500,580,"Southern crossing");point("East_Hub",905,405,"Eastern crossing");
    }else if(map_id=="accessible"){
      point("West_Ramp",95,405,"Wide west passage");point("Centre_Ramp",500,580,"Wide central passage");point("East_Ramp",905,405,"Wide east passage");
    }else if(map_id=="superstore"){
      point("West_Hub",95,285,"West concourse");point("Centre_Hub",500,285,"Central concourse");point("East_Hub",905,285,"East concourse");point("South_Hub",500,580,"South concourse");point("North_Link",500,75,"North link");point("East_Link",905,580,"Express exit");
    }
    if(map_id=="cross"){
      edge("Entrance","Aisle_4",6);edge("Entrance","Aisle_1",12);edge("Aisle_1","Aisle_2",7);edge("Aisle_2","Aisle_3",7);
      edge("Aisle_1","Aisle_4",8);edge("Aisle_2","Central_Hub",4);edge("Central_Hub","Aisle_5",4);edge("Central_Hub","Aisle_1",6.5);
      edge("Central_Hub","Aisle_3",6.5);edge("Aisle_4","Aisle_5",7);edge("Aisle_5","Aisle_6",7);
      edge("Aisle_3","Aisle_6",8);edge("Aisle_6","Checkout",5);edge("Aisle_3","Checkout",11);
      edge("Aisle_2","North_Hub",3);edge("North_Hub","Aisle_3",7.5);edge("North_Hub","Aisle_1",7.5);
    }else if(map_id=="loop"){
      edge("Entrance","Aisle_4",6);edge("Entrance","North_West",14);edge("North_West","Aisle_1",4);
      edge("Aisle_1","Aisle_2",7);edge("Aisle_2","Aisle_3",7);edge("Aisle_3","North_East",4);
      edge("North_East","East_Hub",9);edge("East_Hub","Aisle_6",4);edge("Aisle_6","Checkout",5);
      edge("Aisle_6","Aisle_5",7);edge("Aisle_5","Aisle_4",7);edge("Aisle_4","Aisle_1",8);
      edge("Aisle_5","South_Hub",6);edge("South_Hub","Checkout",9);edge("Entrance","South_Hub",9);
      edge("Aisle_2","Aisle_5",8);
    }else if(map_id=="accessible"){
      edge("Entrance","West_Ramp",6,4.4);edge("West_Ramp","Aisle_4",5,4.3);edge("West_Ramp","Aisle_1",9,4.4);
      edge("Aisle_1","Aisle_2",8,4.3);edge("Aisle_2","Aisle_3",8,4.4);
      edge("Aisle_1","Aisle_4",9,4.5);edge("Aisle_2","Aisle_5",9,4.3);edge("Aisle_3","Aisle_6",9,4.5);
      edge("Aisle_4","Aisle_5",8,4.4);edge("Aisle_5","Aisle_6",8,4.4);
      edge("Aisle_5","Centre_Ramp",6,4.5);edge("Centre_Ramp","Checkout",9,4.4);edge("Centre_Ramp","Entrance",9,4.5);
      edge("Aisle_6","East_Ramp",5,4.3);edge("East_Ramp","Checkout",6,4.5);edge("Aisle_3","East_Ramp",10,4.3);
    }else if(map_id=="superstore"){
      edge("Entrance","Aisle_4",6);edge("Entrance","West_Hub",8);edge("West_Hub","Aisle_1",5);
      edge("West_Hub","Aisle_4",5);edge("West_Hub","Centre_Hub",9);edge("Centre_Hub","East_Hub",9);
      edge("Aisle_1","Aisle_2",7);edge("Aisle_2","Aisle_3",7);edge("Aisle_1","Aisle_4",8);
      edge("Aisle_2","Centre_Hub",4);edge("Centre_Hub","Aisle_5",4);edge("Aisle_3","Aisle_6",8);
      edge("Aisle_3","East_Hub",5);edge("East_Hub","Aisle_6",5);edge("Aisle_4","Aisle_5",7);
      edge("Aisle_5","Aisle_6",7);edge("Aisle_5","South_Hub",6);edge("South_Hub","Checkout",9);
      edge("Entrance","South_Hub",9);edge("Aisle_6","East_Link",6);edge("East_Link","Checkout",1.8);
      edge("Aisle_2","North_Link",3);edge("North_Link","Aisle_1",7.5);edge("North_Link","Aisle_3",7.5);
    }else{
      edge("Entrance","Aisle_4",6);edge("Entrance","Aisle_1",12);edge("Aisle_1","Aisle_2",7);
      edge("Aisle_2","Aisle_3",7);edge("Aisle_1","Aisle_4",8);edge("Aisle_2","Aisle_5",8);
      edge("Aisle_3","Aisle_6",8);edge("Aisle_4","Aisle_5",7);edge("Aisle_5","Aisle_6",7);
      edge("Aisle_6","Checkout",5);edge("Aisle_3","Checkout",11);
      if(map_id=="compact"){
        edge("Entrance","Aisle_5",10);edge("Aisle_4","Aisle_2",9);edge("Aisle_5","Checkout",11);
        for(auto&e:edges)e.meters*=0.82;
      }
    }
    for(auto&n:nodes)for(auto&s:skus)if(n.id==s.aisle)n.products++;
  }
  RouteResult pathfind(const string&start,const string&end,const string&algorithm="")const{
    const string&algo=algorithm.empty()?planner:algorithm;
    auto tic=Clock::now();RouteResult r;
    if(start==end){r.path={start};r.visited=1;return r;}
    map<string,double>d;map<string,string>parent;set<string>finished;
    for(auto&n:nodes)d[n.id]=numeric_limits<double>::infinity();
    d[start]=0;
    double min_ratio=1;
    for(auto&e:edges)min_ratio=min(min_ratio,e.meters/max(1.,dist(N(e.a),N(e.b))));
    auto heur=[&](const string&v){return algo=="A*"?dist(N(v),N(end))*min_ratio:0.;};
    using Entry=pair<double,string>;
    priority_queue<Entry,vector<Entry>,greater<Entry>>pq;pq.push({heur(start),start});
    while(!pq.empty()){
      auto [pri,u]=pq.top();pq.pop();(void)pri;
      if(finished.count(u))continue;
      finished.insert(u);r.visited++;
      if(u==end)break;
      for(auto&e:edges){if(e.blocked)continue;string v;if(e.a==u)v=e.b;else if(e.b==u)v=e.a;else continue;
        double w=algo=="BFS"?1:e.meters;
        if(d[u]+w<d[v]){d[v]=d[u]+w;parent[v]=u;pq.push({d[v]+heur(v),v});}
      }
    }
    if(!isfinite(d[end])){r.path={start};r.cost=0;}
    else{
      string u=end;r.path.push_back(u);while(u!=start){u=parent[u];r.path.push_back(u);}reverse(r.path.begin(),r.path.end());
      r.cost=0;for(size_t i=1;i<r.path.size();i++)r.cost+=E(r.path[i-1],r.path[i])->meters;
    }
    r.micros=chrono::duration<double,micro>(Clock::now()-tic).count();return r;
  }
  RouteResult corridor_route(const string&target,bool reverse_direction=false,const string& algorithm="Dijkstra")const{
    if(heading.empty())return pathfind(node,target,algorithm);
    const string&junction=reverse_direction?node:heading;
    RouteResult result=pathfind(junction,target,algorithm);
    result.path.insert(result.path.begin(),reverse_direction?heading:node);
    result.cost+=(reverse_direction?progress:1-progress)*E(node,heading)->meters;
    return result;
  }
  void plan(bool count=false){auto old=route;string target=destination.empty()?goal_node():destination;planned=detour||destination.empty()?corridor_route(target):pathfind(node,target);route=planned.path;map_visits+=planned.visited;
    if(count&&old!=route){reroutes++;log("reroute","Route recomputed: "+target);}}
  string goal_node()const{if(nearest_goal<0||nearest_goal>=int(goals.size()))return "Checkout";return skus[goals[nearest_goal].idx].aisle;}
  string goal_name()const{if(nearest_goal<0||nearest_goal>=int(goals.size()))return "Checkout";return skus[goals[nearest_goal].idx].name;}
  void find_goal(){nearest_goal=-1;double best=1e15;for(size_t i=0;i<goals.size();i++){if(goals[i].status!="pending")continue;const auto& aisle=skus[goals[i].idx].aisle;auto p=corridor_route(aisle);double cost=p.path.back()==aisle?p.cost:1e12;
     if(cost<best){best=cost;nearest_goal=int(i);}}
    plan();
  }
  void reset(bool inc=true){if(inc)session++;rng.seed(seed+session);clock=0;progress=0;distance=0;walking=false;complete=false;chaos_acc=0;auto_acc=0;retreating=false;nearest_goal=-1;
    verified=skips=alerts=reroutes=scans=low_conf=allergen_blocks=wrong=map_visits=0;node="Entrance";heading="";previous="";destination="";state="NAVIGATING";
    hazards.clear();cart.clear();cart_sources.clear();events.clear();history.clear();scan_state=nullptr;pending_scan=-1;sensors=Sensor();
    remaining_stock.clear();for(auto&p:skus)remaining_stock.push_back(p.stock);
    selected_shelf_id="Aisle_1_L";
    if(detour)mode=detour->resume_mode;
    else if(mode=="SHELF_VISIT")mode="FREE";
    detour.reset();
    build_map();goals.clear();for(auto&sku_id:shopping.at(list_name)){int index=product_index(sku_id);if(index>=0)goals.push_back({index});}
    log("start","Started "+list_name+" · "+map_id+" · "+planner);find_goal();say("Navigation ready. Next item: "+goal_name()+".");
  }
  pair<double,double> xy()const{const auto&a=N(node);if(heading.empty())return {a.x,a.y};const auto&b=N(heading);return {a.x+(b.x-a.x)*progress,a.y+(b.y-a.y)*progress};}
  double edge_progress(const Hazard&h,const string&a,const string&b)const{return h.a==a&&h.b==b?h.t:1-h.t;}
  double hazard_distance(const Hazard&h)const{
    string a=node;string b=heading;
    if(b.empty()&&route.size()>1)b=route[1];
    if(b.empty()||!E(a,b))return 1e10;
    if(!((h.a==a&&h.b==b)||(h.b==a&&h.a==b)))return 1e10;
    double rel=edge_progress(h,a,b);if(rel<progress)return 1e10;
    return max(0.06,(rel-progress)*E(a,b)->meters-h.width/2);
  }
  void sense(){sensors=Sensor();double closest=1e10;Hazard*nearest=nullptr;
    for(auto&h:hazards){double dd=hazard_distance(h);if(dd<closest){closest=dd;nearest=&h;}}
    if(nearest&&closest<=6){
      normal_distribution<double>na(0,0.07),nb(0,0.04),nc(0,0.13);
      sensors.detected=true;sensors.actual=rounded(closest);sensors.label=nearest->label;
      sensors.rgbd=clamp(closest+na(rng),0.06,6.);sensors.tof=clamp(closest+nb(rng),0.06,4.);
      sensors.mono=clamp(closest+nc(rng),0.06,9.);sensors.fused=min({sensors.rgbd,sensors.tof,sensors.mono});
      sensors.alert=sensors.fused<=1.2;
      if(sensors.alert&&!nearest->alerted){nearest->alerted=true;alerts++;log("hazard",nearest->label+" detected at "+to_string(rounded(sensors.fused,1))+" m");say("Stop. "+nearest->label+" ahead. Path obstructed.");
        if(auto*edge=E(nearest->a,nearest->b))edge->blocked=true;
        if(!heading.empty()){
          swap(node,heading);progress=1.-progress;retreating=true;
        }else{walking=false;}
        if(!detour&&mode!="SHELF_VISIT")destination.clear();
        plan(true);
      }
    }
  }
  void spawn(bool moving=false){string a=node,b=heading.empty()?(route.size()>1?route[1]:""):heading;
    if(b.empty()||!E(a,b)){say("No adjacent route available for placing an obstacle.");return;}
    auto*e=E(a,b);double t=heading.empty()?.6:max(progress+0.15,min(.88,progress+2.8/e->meters));
    t=min(.91,t);vector<pair<string,string>>kinds={{"cart","Shopping trolley"},{"person","Moving shopper"},{"spill","Floor spill"},{"crate","Restocking crate"}};
    int i=int(rng()%kinds.size());bool dynam=chaos||moving;
    Hazard h{next_hazard_id++,a,b,kinds[i].first,kinds[i].second,t,dynam?25.:-1.,dynam?(i%2?0.075:-0.055):0.,.6};
    hazards.push_back(h);log("obstacle",h.label+" appeared on "+a+" → "+b);
  }
  void toggle_obstacle(){if(!hazards.empty()){
    hazards.clear();for(auto&e:edges)e.blocked=false;plan(true);say("Obstacles removed; the corridor is clear.");
   }else spawn(false);
  }
  void tick(double dt){if(dt<=0)return;dt=min(dt,.08)*speed;clock+=dt;chaos_acc+=dt;auto_acc+=dt;
    for(auto it=hazards.begin();it!=hazards.end();){
      if(it->ttl>0)it->ttl-=dt;
      if(it->speed!=0){it->t+=it->speed*dt;if(it->t<.2||it->t>.88)it->speed*=-1;it->t=clamp(it->t,.2,.88);}
      if(it->ttl>=0&&it->ttl<=0){if(auto*e=E(it->a,it->b))e->blocked=false;log("clear",it->label+" cleared");it=hazards.erase(it);plan(true);}else ++it;
    }
    if(chaos&&chaos_acc>10.5&&hazards.size()<2){chaos_acc=0;spawn(true);}
    if(complete){walking=false;record(dt);return;}
    sense();
    if((mode=="AUTO"||mode=="SHELF_VISIT")&&auto_acc>.35){auto_acc=0;
      if(mode=="SHELF_VISIT"){
        if(!heading.empty()){
          if(!retreating)walking=true;
        }else if(node==destination)arrive_at_shelf();
        else if(!walking){plan();if(route.size()>1)start(route[1]);}
      }else{
        if(!heading.empty()){
          if(!retreating)walking=true;
        }else if(node==goal_node()&&nearest_goal>=0)scan(true);
        else if(node=="Checkout"&&nearest_goal<0)finish();
        else if(!walking){if(destination.empty())plan();if(route.size()>1)start(route[1]);}
      }
    }
    if(walking&&!heading.empty()){
      auto*e=E(node,heading);if(!e){walking=false;heading="";}
      else{
        double length=e->meters;
        double step=min(1.-progress,1.8*dt/length);
        progress+=step;distance+=step*length;
        if(progress>=1-1e-9){string arrived=heading;previous=node;node=arrived;heading="";progress=0;walking=false;
          if(retreating){retreating=false;plan(true);log("safety","Returned to previous junction");}
          if((detour||mode=="SHELF_VISIT")&&node==destination)arrive_at_shelf();
          else if(!detour&&mode!="SHELF_VISIT"&&node==goal_node()&&nearest_goal>=0){
            plan();state="AT_SHELF";say("Arrived at "+N(node).label+". Scan the shelf to verify "+goal_name()+".");
          }
          else if(!detour&&mode!="SHELF_VISIT"&&node=="Checkout"&&nearest_goal<0){finish();}
          else{plan();state="NAVIGATING";log("arrival","Arrived at "+N(node).label);}
        }
      }
    }
    if(!sensors.alert&&state=="HAZARD_OVERRIDE")state="NAVIGATING";
    record(dt);
  }
  double hist_acc=0;
  void record(double dt){hist_acc+=dt;if(hist_acc<.24)return;hist_acc=0;
    history.push_back(Obj{{"t",rounded(clock,1)},{"range",rounded(sensors.fused)},{"rgbd",rounded(sensors.rgbd)},{"tof",rounded(sensors.tof)},{"speed",walking?1.8:0.},{"hazard",sensors.alert}});
    if(history.size()>90)history.erase(history.begin(),history.begin()+10);
  }
  bool start(const string&next){if(complete)return false;if(!heading.empty())return false;
    Edge*e=E(node,next);if(!e){say("No connected corridor to that location.");return false;}
    if(e->blocked){say("This corridor is blocked. Choose another route.");return false;}
    pending_scan=-1;
    heading=next;progress=0;walking=true;retreating=false;state="NAVIGATING";
    if((detour||destination.empty())&&(route.size()<2||route[1]!=next))plan();
    log("move","Walking toward "+N(next).label);return true;
  }
  void navigate(const string&target){if(!has_node(target))throw runtime_error("Unknown destination: "+target);if(complete)return;
    if(!heading.empty()){say("Finish the current corridor before choosing a new destination.");return;}
    if(detour){
      if(target==destination&&route.size()>1)start(route[1]);
      else if(E(node,target))start(target);
      else say(node==target?"You are here.":"Choose an adjacent junction or use Start walking to follow the product route.");
      return;
    }
    destination=target;plan();if(route.size()<2){if(node==target)say("You are already at "+N(node).label);else say("No safe route to target.");return;}
    if(target==goal_node())destination.clear();
    start(route[1]);
    say("Routing to "+N(target).label+" via "+planner+".");
  }
  bool has_node(const string&id)const{return any_of(nodes.begin(),nodes.end(),[&](auto&n){return n.id==id;});}
  void turnback(){if(!heading.empty()){
    swap(node,heading);progress=1.-progress;retreating=true;walking=true;mode="FREE";
    if(!detour)destination.clear();
    plan();say("Turning back toward the previous junction.");
   }else if(!previous.empty()&&E(node,previous)){
     mode="FREE";start(previous);
   }else say("No previous corridor to return to.");
  }
  void forward(){if(!heading.empty()){walking=true;return;}if(route.size()>1)start(route[1]);else say("You have reached this destination.");}
  void choose(int num){vector<string>near=neighbors();if(num>=1&&num<=int(near.size())){
    if(!heading.empty()){say("Choose an open path from a junction.");return;}
    mode="FREE";if(!detour)destination.clear();start(near[num-1]);
  }else say("That path number is not available.");}
  vector<string> neighbors()const {vector<string>v;for(auto&e:edges){if(e.a==node)v.push_back(e.b);if(e.b==node)v.push_back(e.a);}sort(v.begin(),v.end());return v;}
  void steer(double x,double y){if(!heading.empty())return;double best=-1;string selected;
    for(auto&v:neighbors()){auto a=N(node),b=N(v);double dx=b.x-a.x,dy=b.y-a.y;double d=hypot(dx,dy);double s=(dx*x+dy*y)/max(1.,d*hypot(x,y));if(s>best){best=s;selected=v;}}
    if(best>.45){
      mode="FREE";if(!detour)destination.clear();start(selected);
    }else say("No corridor in that direction.");
  }
  bool on_shopping_list(int idx)const{
    return any_of(goals.begin(),goals.end(),[idx](const Goal&goal){return goal.idx==idx;});
  }
  int pending_goal(int idx)const{
    for(size_t i=0;i<goals.size();i++)if(goals[i].idx==idx&&goals[i].status=="pending")return int(i);
    return -1;
  }
  string manual_mode()const{return mode=="GUIDED"?"GUIDED":"FREE";}
  int find_requested_product(const string&query)const{
    const string words=product_words(query);
    if(words.empty())throw runtime_error("Name a product, for example: I want instant coffee.");
    int best=-1;
    vector<int> matches;
    for(size_t i=0;i<skus.size();i++){
      const auto&product=skus[i];
      const string name=product_words(product.name);
      const string base=product_words(product.name.substr(0,product.name.find_first_of("0123456789")));
      const int rank=words==name||words==product_words(product.id)?3:words==base?2:
        words==product_words(product.family)?1:(" "+name+" ").find(" "+words+" ")!=string::npos?0:-1;
      if(rank<0||rank<best)continue;
      if(rank>best){matches.clear();best=rank;}
      matches.push_back(int(i));
    }
    if(matches.empty())throw runtime_error("No catalogue product matches “"+query+"”. Try a product name such as instant coffee.");
    vector<int> available;
    copy_if(matches.begin(),matches.end(),back_inserter(available),[&](int idx){
      return remaining_stock[idx]>0&&!restricted(skus[idx])&&(!on_shopping_list(idx)||pending_goal(idx)>=0);
    });
    if(available.empty()){
      if(matches.size()==1){
        const int idx=matches.front();const auto&product=skus[idx];
        if(restricted(product))throw runtime_error(product.name+" is restricted by your accessibility profile.");
        if(remaining_stock[idx]<=0)throw runtime_error(product.name+" is out of stock.");
        throw runtime_error(product.name+" has already been handled on your shopping list.");
      }
      throw runtime_error("The matching products have already been handled, are out of stock, or are restricted.");
    }
    if(available.size()>1){
      string message="Which product? Try ";
      for(size_t i=0;i<min(size_t(4),available.size());i++)message+=(i?", ":"")+skus[available[i]].name;
      throw runtime_error(message+".");
    }
    return available.front();
  }
  void arrive_at_shelf(){
    if(mode=="SHELF_VISIT")mode="FREE";
    walking=false;
    state="AT_SHELF";
    plan();
    if(detour){
      const auto&product=skus[detour->idx];
      selected_shelf_id=product.shelf;
      say("Arrived at "+N(node).label+", "+(product.shelf.back()=='L'?"left":"right")+" rack. Add "+product.name+" to your basket.");
    }else say("Arrived at "+N(node).label+". Choose an item from the selected shelf.");
  }
  void face_shortest_route(const string&aisle){
    const auto forward_route=corridor_route(aisle);
    const bool reachable=forward_route.path.back()==aisle;
    if(!heading.empty()&&!retreating&&!E(node,heading)->blocked){
      const auto reverse_route=corridor_route(aisle,true);
      if(reverse_route.path.back()==aisle&&(!reachable||reverse_route.cost<forward_route.cost)){
        swap(node,heading);
        progress=1-progress;
        return;
      }
    }
    if(!reachable)throw runtime_error("No open route to "+N(aisle).label+". Try again when a corridor clears.");
  }
  void show_goal_route(int goal){
    if(complete)return;
    const string aisle=goal>=0?skus[goals[goal].idx].aisle:"Checkout";
    face_shortest_route(aisle);
    const string next_mode=detour?detour->resume_mode:manual_mode();
    detour.reset();
    if(nearest_goal!=goal)pending_scan=-1;
    nearest_goal=goal;
    if(goal>=0)selected_shelf_id=skus[goals[goal].idx].shelf;
    destination.clear();
    mode=next_mode;
    walking=false;
    plan();
    const bool here=heading.empty()&&node==aisle;
    state=here&&goal>=0?"AT_SHELF":"NAVIGATING";
    if(here&&goal>=0)say("You are at the shelf for "+goal_name()+". Scan to find the item.");
    else if(here)finish();
    else say("Shortest route to "+goal_name()+" shown. Use Start walking or choose the next corridor when ready.");
  }
  void request_product(const string&query){
    if(complete)throw runtime_error("Checkout completed. Start a new trip to shop for more products.");
    const int idx=find_requested_product(query);
    const int list_goal=pending_goal(idx);
    if(list_goal>=0){show_goal_route(list_goal);return;}
    const auto&product=skus[idx];
    face_shortest_route(product.aisle);
    const string resume_mode=detour?detour->resume_mode:manual_mode();
    detour=ProductDetour{idx,resume_mode};
    pending_scan=-1;
    selected_shelf_id=product.shelf;
    destination=product.aisle;
    mode=resume_mode;
    walking=false;
    log("travel","Route shown for "+product.name+" at "+product.shelf);
    if(heading.empty()&&node==destination)arrive_at_shelf();
    else{
      state="NAVIGATING";
      plan();
      say("Shortest route to "+product.name+" at "+N(destination).label+", "+
        (product.shelf.back()=='L'?"left":"right")+" rack. Use Start walking when ready.");
    }
  }
  void end_product_detour(string next_mode){
    detour.reset();
    destination.clear();
    mode=next_mode;
    walking=false;
    find_goal();
    state=heading.empty()&&nearest_goal>=0&&node==goal_node()?"AT_SHELF":"NAVIGATING";
  }
  void finish_goal(const string&status){if(nearest_goal<0)return;
    pending_scan=-1;
    goals[nearest_goal].status=status;if(status=="found")verified++;if(status=="skipped")skips++;
    destination.clear();find_goal();state="NAVIGATING";walking=false;
    if(nearest_goal>=0)say("Next objective: "+goal_name()+".");else say("Shopping list complete. Proceed to checkout.");
  }
  void finish(){if(complete)return;complete=true;state="COMPLETE";walking=false;log("complete","Session finished at checkout");say("Checkout reached. "+to_string(verified)+" items verified. Session complete.");}
  void collect_scanned_product(){
    const int idx=goals[nearest_goal].idx;
    const auto& product=skus[idx];
    cart.push_back(idx);cart_sources.push_back("scan");remaining_stock[idx]--;
    scan_state.as_object()["outcome"]="verified";
    log("purchase",product.name+" added to your basket after scanning.");
    finish_goal("found");
    say(product.name+" added to your basket. Next: "+goal_name()+".");
  }
  void confirm_scan(const string&id){
    if(pending_scan<0||skus[pending_scan].id!=id||nearest_goal<0||goals[nearest_goal].idx!=pending_scan||
       node!=goal_node()||!heading.empty()||detour||complete)
      throw runtime_error("Scan the current list item at its shelf before adding it.");
    if(remaining_stock[pending_scan]<=0||restricted(skus[pending_scan]))throw runtime_error("This item is unavailable for purchase.");
    collect_scanned_product();
  }
  void scan(bool automatic=false){if(complete)return;if(detour){say("Resume your shopping list before scanning a list item.");return;}if(nearest_goal<0||node!=goal_node()||!heading.empty()){
     say("Reach the target shelf before scanning.");return;
   }
   if(pending_scan>=0)return;
   if(!automatic)mode=manual_mode();
   Goal&g=goals[nearest_goal];const auto&target=skus[g.idx];g.tries++;scans++;
   if(remaining_stock[g.idx]<=0){
     log("stock","Target is out of stock: "+target.name);
     say(target.name+" is unavailable. Moving to the next list item.");
     scan_state=Obj{{"outcome","out_of_stock"},{"target",target.name},{"target_id",target.id},
       {"score",0.},{"attempt",g.tries},{"lighting",lighting},{"threshold",.75},
       {"detections",Arr{}},{"provenance","Synthetic inventory and recognition demo"}};
     finish_goal("unavailable");return;
   }
   auto&local=rng;
   normal_distribution<double>jitter(0,.035);
   double conf=clamp((lighting=="dim"?.72:lighting=="bright"?.88:.84)+jitter(local)+.035*(g.tries-1),.3,.97);
   Arr detections;
   vector<int> candidates;for(int i=0;i<int(skus.size());i++)if(skus[i].aisle==target.aisle)candidates.push_back(i);
   shuffle(candidates.begin(),candidates.end(),rng);
   vector<int> shown={g.idx};for(auto id:candidates)if(id!=g.idx&&shown.size()<6)shown.push_back(id);
   if(shown.size()<6)for(size_t i=0;i<skus.size()&&shown.size()<6;i++)if(int(i)!=g.idx)shown.push_back(int(i));
   for(int i=0;i<6;i++){
     double score=i==0?conf:clamp(.32+.055*(rng()%7)+jitter(local),.12,.86);
     detections.push_back(Obj{{"id",skus[shown[i]].id},{"name",skus[shown[i]].name},
       {"score",rounded(score,3)},{"selected",i==0},{"box",Arr{.065+(i%3)*.315,.18+(i/3)*.38,.245,.27}},
       {"rank",i+1},{"category",skus[shown[i]].family}});
   }
   bool allergic=false;string allergen;
   for(auto&a:target.allergens)if(find(profiles[profile].begin(),profiles[profile].end(),a)!=profiles[profile].end()){allergic=true;allergen=a;}
   string outcome;
   if(allergic){outcome="allergen_block";allergen_blocks++;log("allergen","Unsafe item blocked: "+target.name+" / "+allergen);say("Safety restriction. "+target.name+" contains "+allergen+". Item not added.");finish_goal("blocked");}
   else if(conf<.75){outcome="low_confidence";low_conf++;log("scan","Low recognition confidence for "+target.name);say("Recognition confidence is low. Adjust lighting and scan again.");
     if(g.tries>=3){finish_goal("skipped");}
   }else{outcome="found";log("scan","Found "+target.name+" at "+to_string(rounded(conf,2)));}
   scan_state=Obj{{"outcome",outcome},{"target",target.name},{"target_id",target.id},{"score",rounded(conf,3)},
       {"attempt",g.tries},{"lighting",lighting},{"threshold",.75},{"detections",detections},
       {"provenance","Synthetic embedding-match demonstration; not live camera inference"}};
   if(outcome=="found"){
     if(automatic)collect_scanned_product();
     else{
       pending_scan=g.idx;
       selected_shelf_id=target.shelf;
       state="AT_SHELF";
       say("Found "+target.name+". Add it to your basket?");
     }
   }
  }
  void buy_product(const Obj&purchase){
    string id=getstr(purchase,"sku_id");int idx=product_index(id);
    if(idx<0)throw runtime_error("Unknown catalogue product");
    const auto&p=skus[idx];
    if(p.shelf!=selected_shelf_id)throw runtime_error("Select the shelf containing this product first");
    if(node!=p.aisle||!heading.empty())throw runtime_error("Navigate to "+N(p.aisle).label+" before adding products from this shelf");
    if(complete)throw runtime_error("Checkout completed; reset to start a new trip");
    if(restricted(p))throw runtime_error("Allergen restriction: this product cannot be added for the selected profile");
    int quantity=1;
    auto it=purchase.find("quantity");if(it!=purchase.end()){
      if(!it->value().is_int64()&&!it->value().is_uint64())throw runtime_error("Quantity must be an integer");
      quantity=int(it->value().to_number<int64_t>());
    }
    if(quantity<1||quantity>12)throw runtime_error("Quantity must be between 1 and 12");
    if(remaining_stock[idx]<quantity)throw runtime_error("Not enough stock left on this shelf");
    if(!detour){mode="FREE";walking=false;destination.clear();}
    for(int j=0;j<quantity;j++){cart.push_back(idx);cart_sources.push_back("shelf");}
    remaining_stock[idx]-=quantity;
    bool list_found=false;
    for(auto&g:goals)if(g.idx==idx&&g.status=="pending"){
      g.status="found";verified++;list_found=true;break;
    }
    log("purchase",to_string(quantity)+" × "+p.name+" added from "+selected_shelf_id+
        (list_found?" (shopping objective fulfilled)":" (extra purchase)"));
    if(detour&&detour->idx==idx){
      end_product_detour(detour->resume_mode);
      say(p.name+" added to your basket. Back to your shopping list. Next: "+goal_name()+".");
      return;
    }
    if(list_found){pending_scan=-1;find_goal();}else plan();
    say(to_string(quantity)+" "+p.name+" added to your basket. Total updated.");
  }
  void action(const Obj&cmd){string a=getstr(cmd,"action");auto it=cmd.find("value");bj::value v=it==cmd.end()?bj::value(nullptr):it->value();
    if(a=="request_product"){
      if(!v.is_string())throw runtime_error("Provide a product name or SKU.");
      request_product(str(v));return;
    }
    if(a=="route_to_goal"){show_goal_route(nearest_goal);return;}
    if(a=="confirm_scan"){
      if(!v.is_string())throw runtime_error("Provide the scanned product SKU.");
      confirm_scan(str(v));return;
    }
    if(a=="dismiss_scan"){
      if(pending_scan>=0&&v.is_string()&&skus[pending_scan].id==str(v)){
        pending_scan=-1;
        say("Item left on your shopping list. Scan it again when ready.");
      }
      return;
    }
    if(a=="resume_list"){
      if(detour){end_product_detour(detour->resume_mode);say("Back to your shopping list. Next: "+goal_name()+".");}
      return;
    }
    if(a=="select_shelf"){
      string id=str(v);if(shelf_aisle(id).empty())throw runtime_error("Unknown shelf");
      selected_shelf_id=id;log("shelf","Selected "+N(shelf_aisle(id)).label+(id.back()=='L'?" · left rack":" · right rack"));return;
    }
    if(a=="buy"){if(!v.is_object())throw runtime_error("Purchase must contain sku_id and quantity");buy_product(v.as_object());return;}
    if(a=="visit_shelf"){
      string id=str(v);string aisle=shelf_aisle(id);
      if(aisle.empty())throw runtime_error("Unknown shelf");
      if(complete)throw runtime_error("Session complete; reset to continue shopping");
      if(detour)end_product_detour("FREE");
      pending_scan=-1;
      selected_shelf_id=id;destination=aisle;mode="SHELF_VISIT";walking=!heading.empty();
      plan();log("travel","Auto-walking to selected shelf "+id);
      if(node==destination&&heading.empty()){
        mode="FREE";say("Already at the selected shelf.");
      }else say("Navigating to "+N(aisle).label+" for shelf shopping.");
      return;
    }
    if(a=="reset"){reset();return;}
    if(a=="map"){string id=str(v);if(find(map_ids.begin(),map_ids.end(),id)==map_ids.end())throw runtime_error("Unknown map");map_id=id;reset();return;}
    if(a=="planner"){string id=str(v);if(find(algorithms.begin(),algorithms.end(),id)==algorithms.end())throw runtime_error("Unknown planner");planner=id;plan();log("planner","Switched to "+planner);return;}
    if(a=="profile"){string id=str(v);if(!profiles.count(id))throw runtime_error("Unknown accessibility profile");profile=id;reset();return;}
    if(a=="list"){string id=str(v);if(!shopping.count(id))throw runtime_error("Unknown shopping list");list_name=id;reset();return;}
    if(a=="lighting"){string id=str(v);if(id!="normal"&&id!="dim"&&id!="bright")throw runtime_error("Unknown lighting");lighting=id;log("environment","Lighting changed to "+id);return;}
    if(a=="speed"){double z=v.to_number<double>();if(z!=.5&&z!=1&&z!=2&&z!=4)throw runtime_error("Speed must be 0.5, 1, 2, or 4");speed=z;return;}
    if(a=="mode"){string id=str(v);if(id!="AUTO"&&id!="FREE"&&id!="GUIDED")throw runtime_error("Unknown navigation mode");
      if(detour&&id=="AUTO")end_product_detour(id);else{mode=id;walking=false;}log("mode",id);return;}
    if(a=="chaos"){chaos=v.is_bool()?v.as_bool():!chaos;log("environment",chaos?"Dynamic obstacles enabled":"Dynamic obstacles disabled");return;}
    if(a=="node"){navigate(str(v));return;}
    if(a=="option"){choose(int(v.to_number<int64_t>()));return;}
    if(a=="steer"){auto ar=v.as_array();if(ar.size()!=2)throw runtime_error("Direction must have x and y");steer(ar[0].to_number<double>(),ar[1].to_number<double>());return;}
    if(a=="pause_detour"){if(detour){walking=false;say("Paused. The product route is still shown.");}return;}
    if(a=="forward"){forward();return;}
    if(a=="walk"){if(walking){walking=false;say("Paused.");}else forward();return;}
    if(a=="stop"){walking=false;mode="FREE";if(!detour){destination.clear();plan();}say("Movement stopped.");return;}
    if(a=="reverse"){turnback();return;}
    if(a=="scan"){scan();return;}
    if(a=="skip"){if(detour)say("Resume your shopping list before skipping a list item.");else finish_goal("skipped");return;}
    if(a=="obstacle"){toggle_obstacle();return;}
    if(a=="describe"){say("You are at "+N(node).label+". Next objective "+goal_name()+". "+to_string(neighbors().size())+" connected corridors.");return;}
    if(a=="browse"){int count=N(node).products;say(to_string(count)+" catalogue products are located in "+N(node).label+".");return;}
    throw runtime_error("Unsupported action: "+a);
  }
  bj::value snapshot()const{
    Arr jnodes,jedges,jgoals,jcart,jhaz,jroutes,joptions,jevents,jhist,jmaps,plans,jitems,jprofiles,jshelves,jselected_items;
    for(auto&n:nodes)jnodes.push_back(Obj{{"id",n.id},{"label",n.label},{"x",n.x},{"y",n.y},{"count",n.products},{"type",n.type}});
    for(auto&e:edges)jedges.push_back(Obj{{"a",e.a},{"b",e.b},{"meters",rounded(e.meters)},{"width",e.width},{"traffic",e.traffic},{"blocked",e.blocked}});
    for(size_t i=0;i<goals.size();i++){auto&g=goals[i];auto&p=skus[g.idx];jgoals.push_back(Obj{{"id",p.id},{"name",p.name},{"node",p.aisle},{"price",p.price},{"status",g.status},{"attempts",g.tries},{"active",int(i)==nearest_goal},{"family",p.family}});}
    double total=0;int extras=0;
    for(size_t k=0;k<cart.size();k++){auto&p=skus[cart[k]];total+=p.price;
      if(cart_sources[k]=="shelf"&&!on_shopping_list(cart[k]))extras++;
      jcart.push_back(Obj{{"id",p.id},{"name",p.name},{"price",p.price},
        {"source",cart_sources[k]},{"shelf",p.shelf},{"aisle",p.aisle}});
    }
    for(auto&n:nodes)if(n.type=="aisle")for(auto side:{'L','R'}){
      string sid=n.id+"_"+side;int count=0;
      for(auto&sku:skus)if(sku.shelf==sid)count++;
      jshelves.push_back(Obj{{"id",sid},{"aisle",n.id},{"aisle_label",n.label},
        {"side",side=='L'?"Left":"Right"},{"label",n.label+" · "+(side=='L'?"Left rack":"Right rack")},
        {"count",count}});
    }
    const string selected_aisle=shelf_aisle(selected_shelf_id);
    for(size_t i=0;i<skus.size();i++)if(skus[i].shelf==selected_shelf_id){auto&p=skus[i];
      bool in_list=on_shopping_list(int(i));
      int in_cart=int(count(cart.begin(),cart.end(),int(i)));
      Arr allergens;for(auto&a:p.allergens)allergens.push_back(bj::value(a));
      jselected_items.push_back(Obj{{"id",p.id},{"name",p.name},{"price",p.price},
        {"family",p.family},{"stock",remaining_stock[i]},{"allergens",allergens},
        {"restricted",restricted(p)},{"in_list",in_list},{"in_cart",in_cart},{"shelf_id",p.shelf}});
    }
    for(auto&h:hazards)jhaz.push_back(Obj{{"id",h.id},{"a",h.a},{"b",h.b},{"t",rounded(h.t,4)},{"kind",h.kind},{"label",h.label},{"handled",h.alerted}});
    for(auto&v:route)jroutes.push_back(bj::value(v));
    int k=0;for(auto&v:neighbors()){auto&e=*E(node,v);joptions.push_back(Obj{{"key",++k},{"node",v},{"name",N(v).label},{"blocked",e.blocked},{"meters",rounded(e.meters)}});}
    for(auto it=events.rbegin();it!=events.rend()&&jevents.size()<48;it++)jevents.push_back(Obj{{"t",it->at},{"type",it->type},{"msg",it->msg}});
    for(auto&v:history)jhist.push_back(v);
    for(auto&id:map_ids)jmaps.push_back(Obj{{"id",id},{"label",map_label(id)},{"description",map_description(id)}});
    for(auto&kv:shopping)jitems.push_back(bj::value(kv.first));
    for(auto&kv:profiles)jprofiles.push_back(bj::value(kv.first));
    const string target_node=destination.empty()?goal_node():destination;
    const bool shopping_route=detour||destination.empty();
    for(auto&algo:algorithms){auto r=shopping_route?corridor_route(target_node,false,algo):pathfind(node,target_node,algo);
      plans.push_back(Obj{{"name",algo},{"cost",rounded(r.cost)},{"visited",r.visited},{"runtime_us",rounded(r.micros,1)},{"hops",r.path.size()>0?int(r.path.size())-1:0}});}
    auto [x,y]=xy();double remaining=0;for(size_t i=1;i<route.size();i++)if(auto*e=E(route[i-1],route[i]))remaining+=e->meters;
    if(!heading.empty()&&route.size()>1&&route[0]==node&&route[1]==heading)remaining=max(0.,remaining-progress*E(node,heading)->meters);
    bj::value jdetour=nullptr;
    if(detour){
      const auto&product=skus[detour->idx];
      const char*status=node==product.aisle&&heading.empty()?"arrived":
        route.empty()||route.back()!=product.aisle?"blocked":walking?"en_route":"ready";
      jdetour=Obj{{"sku_id",product.id},{"name",product.name},{"aisle",product.aisle},{"shelf_id",product.shelf},
        {"status",status},{"stock",remaining_stock[detour->idx]},{"price",product.price}};
    }
    bj::value scan_purchase=nullptr;
    if(pending_scan>=0){const auto&product=skus[pending_scan];scan_purchase=Obj{{"sku_id",product.id},{"name",product.name},{"price",product.price}};}
    Obj pinfo{{"name",planner},{"cost",rounded(planned.cost)},{"visited",planned.visited},{"runtime_us",rounded(planned.micros,1)},
      {"note",shopping_route?"Shopping routes use the shortest open route by distance":planner=="BFS"?"Fewest edges, not necessarily minimum metres":"Weighted shortest path"}};
    Obj scensor{{"rgbd",rounded(sensors.rgbd)},{"tof",rounded(sensors.tof)},{"mono",rounded(sensors.mono)},
      {"fused",rounded(sensors.fused)},{"threshold",1.2},{"hazard",sensors.alert},{"nearest",sensors.label},
      {"actual",rounded(sensors.actual)},{"detected",sensors.detected}};
    Obj jmetrics{{"extra_purchases",extras},{"basket_items",cart.size()},{"distance",rounded(distance)},{"verified",verified},{"total",goals.size()},{"alerts",alerts},
      {"reroutes",reroutes},{"scans",scans},{"low_confidence",low_conf},{"skipped",skips},
      {"allergen_blocks",allergen_blocks},{"visited_nodes",map_visits},{"cart_total",total}};
    Obj target{{"name",goal_name()},{"node",goal_node()},{"checkout",nearest_goal<0},
      {"price",nearest_goal>=0?skus[goals[nearest_goal].idx].price:0},
      {"shelf_id",nearest_goal>=0?skus[goals[nearest_goal].idx].shelf:""}};
    return Obj{{"version","2.1"},{"session",session},{"time",rounded(clock,1)},{"speed",speed},{"state",state},
      {"mode",mode},{"walking",walking},{"chaos",chaos},{"map",map_id},{"planner",pinfo},
      {"profile",profile},{"list",list_name},{"lighting",lighting},
      {"comparisons",plans},{"options",Obj{{"maps",jmaps},{"planners",Arr{"Dijkstra","A*","BFS"}},{"lists",jitems},
                      {"profiles",jprofiles},{"lighting",Arr{"normal","bright","dim"}}}},
      {"layout",Obj{{"nodes",jnodes},{"edges",jedges}}},
      {"user",Obj{{"x",rounded(x)},{"y",rounded(y)},{"node",node},{"heading_to",heading},{"progress",rounded(progress,4)}}},
      {"goal",target},{"goals",jgoals},{"cart",jcart},{"cart_total",rounded(total)},{"product_detour",jdetour},
      {"shelves",jshelves},
      {"selected_shelf",Obj{{"id",selected_shelf_id},{"aisle",selected_aisle},
        {"label",selected_aisle.empty()?"":N(selected_aisle).label},
        {"side",selected_shelf_id.back()=='L'?"Left":"Right"},
        {"reachable",node==selected_aisle&&heading.empty()},{"items",jselected_items}}},
      {"route",jroutes},
      {"route_distance",rounded(remaining)},{"choices",joptions},{"obstacles",jhaz},{"sensors",scensor},
      {"scan",scan_state},{"scan_purchase",scan_purchase},{"history",jhist},{"metrics",jmetrics},{"events",jevents},
      {"last_speech",last_guidance},{"provenance",Obj{{"engine","Native C++17 scenario simulator"},
       {"data","Synthetic catalogue derived from standalone demo data"},
       {"vision","Synthetic confidence and bounding boxes; not original PyTorch CAQE inference"},
       {"sensor","Illustrative noise model + conservative minimum-distance fusion"}}}};
  }
  bj::value export_log()const{return Obj{{"session",session},{"map",map_id},{"planner",planner},{"profile",profile},
    {"shopping_list",list_name},{"final_state",snapshot()},{"exported_at_sim_time",rounded(clock)}};}
  static string map_label(const string&id){map<string,string> labels={{"standard","Classic market"},{"cross","Cross-aisle"},{"loop","Perimeter loop"},
    {"accessible","Wide-access"},{"compact","Compact express"},{"superstore","Superstore"}};return labels.at(id);}
  static string map_description(const string&id){map<string,string> labels={{"standard","Balanced 8-zone floor plan"},{"cross","Multi-junction central route"},
    {"loop","Circular exploration corridors"},{"accessible","Wider low-density passages"},{"compact","Short-distance express layout"},
    {"superstore","Multi-concourse complex map"}};return labels.at(id);}
};

static void apply_action(Engine& engine,const string& body){
  if(body.size()>8192)throw runtime_error("Request too large");
  engine.action(bj::parse(body).as_object());
}

#ifdef __EMSCRIPTEN__

static unique_ptr<Engine> browser_engine;

template<typename Operation>
static const char* browser_response(Operation operation){
  static string response;
  try{
    response=bj::serialize(operation());
  }catch(const exception& error){
    response=bj::serialize(Obj{{"error",error.what()}});
  }
  return response.c_str();
}

extern "C" {
EMSCRIPTEN_KEEPALIVE const char* simulator_init(const char* catalogue){
  return browser_response([&]{
    browser_engine=make_unique<Engine>(bj::parse(catalogue));
    return bj::value(nullptr);
  });
}

EMSCRIPTEN_KEEPALIVE void simulator_tick(double elapsed){
  browser_engine->tick(elapsed);
}

EMSCRIPTEN_KEEPALIVE const char* simulator_state(){
  return browser_response([]{return browser_engine->snapshot();});
}

EMSCRIPTEN_KEEPALIVE const char* simulator_action(const char* body){
  return browser_response([&]{
    apply_action(*browser_engine,body);
    return browser_engine->snapshot();
  });
}

EMSCRIPTEN_KEEPALIVE const char* simulator_export(){
  return browser_response([]{return browser_engine->export_log();});
}
}

#else

static bj::value load_catalogue(const fs::path& file){
  ifstream in(file);
  if(!in)throw runtime_error("Cannot open dataset: "+file.string());
  return bj::parse(string((istreambuf_iterator<char>(in)),{}));
}

struct Host {
  mutex lock;
  Engine engine;
  fs::path static_path;
  explicit Host(const fs::path&catalogue,const fs::path&frontend):engine(load_catalogue(catalogue)),static_path(frontend){}
};
static string mime(const string&file){
  auto ext=fs::path(file).extension().string();if(ext==".html")return "text/html; charset=utf-8";
  if(ext==".css")return "text/css";
  if(ext==".js")return "text/javascript";
  if(ext==".svg")return "image/svg+xml";
  if(ext==".png")return "image/png";
  if(ext==".woff2")return "font/woff2";
  if(ext==".json")return "application/json";
  return "application/octet-stream";
}
static http::response<http::string_body> answer(const http::request<http::string_body>&req,Host&host){
  http::response<http::string_body>res{http::status::ok,req.version()};res.set(http::field::server,"Saarathi-Cpp-Studio/2.1");res.keep_alive(req.keep_alive());
  const string target=string(req.target());
  try{
    if(target=="/api/health"){res.set(http::field::content_type,"application/json");res.body()=R"({"status":"ok","engine":"cpp17","version":"2.1"})";}
    else if(target=="/api/state"&&req.method()==http::verb::get){lock_guard<mutex>g(host.lock);res.set(http::field::content_type,"application/json");res.body()=bj::serialize(host.engine.snapshot());}
    else if(target=="/api/action"&&req.method()==http::verb::post){
      lock_guard<mutex>g(host.lock);apply_action(host.engine,req.body());
      res.set(http::field::content_type,"application/json");res.body()=bj::serialize(host.engine.snapshot());
    }else if(target=="/api/export"&&req.method()==http::verb::get){lock_guard<mutex>g(host.lock);res.set(http::field::content_type,"application/json");res.set(http::field::content_disposition,"attachment; filename=saarathi_simulation.json");res.body()=bj::serialize(host.engine.export_log());}
    else if(req.method()==http::verb::get&&target.find("..") == string::npos&&target.rfind("/api/",0)!=0){
      fs::path file=host.static_path/(target=="/"?"index.html":target.substr(1));
      if(!fs::exists(file)||!fs::is_regular_file(file))file=host.static_path/"index.html";
      if(fs::exists(file)&&fs::is_regular_file(file)){
        ifstream in(file,ios::binary);res.body()=string(istreambuf_iterator<char>(in),{});res.set(http::field::content_type,mime(file.string()));
      }else{res.result(http::status::not_found);res.body()="React build not present. Use Vite dev server on port 5173.";}
    }else{res.result(http::status::not_found);res.set(http::field::content_type,"application/json");res.body()=R"({"error":"Endpoint not found"})";}
  }catch(const exception&err){res.result(http::status::bad_request);res.set(http::field::content_type,"application/json");Obj msg{{"error",err.what()}};res.body()=bj::serialize(msg);}
  res.prepare_payload();return res;
}
static void service(asio::ip::tcp::socket socket,Host&host){
  try{beast::flat_buffer buf;
    while(true){http::request<http::string_body>req;http::read(socket,buf,req);auto res=answer(req,host);bool keep=res.keep_alive();http::write(socket,res);if(!keep)break;}
  }catch(const beast::system_error&e){if(e.code()!=http::error::end_of_stream&&e.code()!=asio::error::eof)cerr<<"HTTP client error: "<<e.what()<<'\n';}
  catch(const exception&e){cerr<<"Client: "<<e.what()<<'\n';}
  beast::error_code ec;socket.shutdown(asio::ip::tcp::socket::shutdown_both,ec);
}
int main(int argc,char**argv){
  try{
    fs::path root=fs::current_path();fs::path data=root/"data/catalogue.json",dist=root/"frontend/dist";int port=8787;
    for(int i=1;i<argc;i++){
      string a=argv[i];if(a=="--data"&&i+1<argc)data=argv[++i];else if(a=="--dist"&&i+1<argc)dist=argv[++i];else if(a=="--port"&&i+1<argc)port=stoi(argv[++i]);else if(a=="--help"){
        cout<<"saarathi_server [--data data/catalogue.json] [--dist frontend/dist] [--port 8787]\n";return 0;
      }
    }
    if(port<1024||port>65535)throw runtime_error("Invalid port");
    Host host(data,dist);asio::io_context io;asio::ip::tcp::acceptor accept(io,{asio::ip::make_address("127.0.0.1"),static_cast<unsigned short>(port)});
    atomic<bool> running{true};thread ticker([&]{auto last=Clock::now();while(running){this_thread::sleep_for(chrono::milliseconds(34));auto now=Clock::now();double dt=chrono::duration<double>(now-last).count();last=now;lock_guard<mutex>g(host.lock);host.engine.tick(dt);}});
    cout<<"Saarathi native C++17 API → http://127.0.0.1:"<<port<<"\n"<<"  GET /api/health /api/state /api/export  POST /api/action\n"<<flush;
    while(true){asio::ip::tcp::socket sock(io);accept.accept(sock);thread(service,move(sock),ref(host)).detach();}
    running=false;ticker.join();
  }catch(const exception&e){cerr<<"Startup error: "<<e.what()<<'\n';return 1;}
}
#endif