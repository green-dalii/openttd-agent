class ExecutorV1Info extends AIInfo {
	function GetAuthor()      { return "openttd-agent"; }
	function GetName()        { return "ExecutorV1"; }
	function GetDescription() { return "v0.2 agent executor (sign-mailbox consumer)"; }
	function GetVersion()     { return 1; }
	function GetDate()        { return "2026-09-08"; }
	function CreateInstance() { return "ExecutorV1"; }
	function GetShortName()   { return "EXV1"; }
}
RegisterAI(ExecutorV1Info());
