/* 2026-10-08 GS 适配补丁（GPL 允许的修改，原文保留于此声明）：
   ① 基类 AILibrary -> GSLibrary（GS 虚拟机的库基类注册名；四选一探针实测）。
   ② API 类按双名映射改用 GS 名（GS 虚拟机不注册 AI 名，真机实测
      "the index 'AIList' does not exist"）：原 AITile/AIMap/AITunnel/AIBridge/
      AIRoad/AIVehicle/AITestMode/AIList/AIBridgeList_Length 改为 GSTile/GSMap/
      GSTunnel/GSBridge/GSRoad/GSVehicle/GSTestMode/GSList/GSBridgeList_Length。
      语义同一（script_api 双名）。除以上改动外未改任何代码。
   来源包：51554248-Queue.BinaryHeap-1.tar（BaNaNaS，MD5 200e798ae4b3cfa6556e628eaa982e4b）。*/

/* $Id: library.nut 15092 2009-01-15 16:53:18Z truebrain $ */

class Binary_Heap extends GSLibrary {
	function GetAuthor()      { return "OpenTTD NoAI Developers Team"; }
	function GetName()        { return "Binary Heap"; }
	function GetShortName()   { return "QUBH"; }
	function GetDescription() { return "An implementation of a Binary Heap"; }
	function GetVersion()     { return 1; }
	function GetDate()        { return "2008-06-10"; }
	function CreateInstance() { return "Binary_Heap"; }
	function GetCategory()    { return "Queue"; }
}

RegisterLibrary(Binary_Heap());
