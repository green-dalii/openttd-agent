/* 2026-10-08 GS 适配补丁（GPL 允许的修改，原文保留于此声明）：
   ① 基类 AILibrary -> GSLibrary（GS 虚拟机的库基类注册名；四选一探针实测）。
   ② API 类按双名映射改用 GS 名（GS 虚拟机不注册 AI 名，真机实测
      "the index 'AIList' does not exist"）：原 AITile/AIMap/AITunnel/AIBridge/
      AIRoad/AIVehicle/AITestMode/AIList/AIBridgeList_Length 改为 GSTile/GSMap/
      GSTunnel/GSBridge/GSRoad/GSVehicle/GSTestMode/GSList/GSBridgeList_Length。
      语义同一（script_api 双名）。除以上改动外未改任何代码。
   来源包：5046524f-Pathfinder.Road-4.tar（BaNaNaS，MD5 7a7e02051c0b2c177f10f2440e462de7）。*/

/* $Id$ */

// 2012-08-19:
//   Version 3 -> 4: Updated to use AyStar 6 (instead of 4) by Zuu

class Road extends GSLibrary {
	function GetAuthor()      { return "OpenTTD NoAI Developers Team"; }
	function GetName()        { return "Road"; }
	function GetShortName()   { return "PFRO"; }
	function GetDescription() { return "An implementation of a road pathfinder"; }
	function GetVersion()     { return 4; }
	function GetDate()        { return "2012-08-19"; }
	function CreateInstance() { return "Road"; }
	function GetCategory()    { return "Pathfinder"; }
}

RegisterLibrary(Road());
