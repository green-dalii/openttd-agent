class BridgeV1Info extends GSInfo {
	function GetAuthor()      { return "openttd-agent"; }
	function GetName()        { return "BridgeV1"; }
	function GetDescription() { return "v0.2 agent bridge (admin relay + sign mailbox)"; }
	function GetVersion()     { return 1; }
	function GetDate()        { return "2026-09-08"; }
	function CreateInstance() { return "BridgeV1"; }
	function GetShortName()   { return "BV01"; }
	function GetAPIVersion()  { return "15"; }
}
RegisterGS(BridgeV1Info());
