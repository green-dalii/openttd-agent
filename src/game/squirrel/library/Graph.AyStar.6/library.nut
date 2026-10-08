/* 2026-10-08 GS 适配补丁（GPL 允许的修改，原文保留于此声明）：
   ① 基类 AILibrary -> GSLibrary（GS 虚拟机的库基类注册名；四选一探针实测）。
   ② API 类按双名映射改用 GS 名（GS 虚拟机不注册 AI 名，真机实测
      "the index 'AIList' does not exist"）：原 AITile/AIMap/AITunnel/AIBridge/
      AIRoad/AIVehicle/AITestMode/AIList/AIBridgeList_Length 改为 GSTile/GSMap/
      GSTunnel/GSBridge/GSRoad/GSVehicle/GSTestMode/GSList/GSBridgeList_Length。
      语义同一（script_api 双名）。除以上改动外未改任何代码。
   来源包：4752412a-Graph.AyStar-6.tar（BaNaNaS，MD5 300052317e050fbd12f983c995fa4000）。*/

class AyStar extends GSLibrary {
	function GetAuthor()      { return "OpenTTD NoAI Developers Team"; }
	function GetName()        { return "AyStar"; }
	function GetShortName()   { return "GRA*"; }
	function GetDescription() { return "An implementation of AyStar"; }
	function GetVersion()     { return 6; }
	function GetDate()        { return "2008-06-03"; }
	function CreateInstance() { return "AyStar"; }
	function GetCategory()    { return "Graph"; }
}

RegisterLibrary(AyStar());
