; MarkNotes installer (Inno Setup 6).
; Build:  ISCC.exe /DSourceDir=<publish folder> MarkNotes.iss
; Per-user install by default (no admin rights needed). Notes and settings are never
; touched by the installer or the uninstaller.

#define AppName "MarkNotes"
#define AppVersion "2.5.1"
#define AppExe "MarkNotes.exe"
#ifndef SourceDir
  #define SourceDir "..\..\publish"
#endif
; Speech model the installer can fetch (same file the app's Settings › Transcription downloads).
#ifndef ModelFile
  #define ModelFile "ggml-large-v3-turbo-q5_0.bin"
  #define ModelSha "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2"
  #define ModelSize "574041195"
  #define ModelLabel "Large v3 Turbo, 547 MB"
#endif
#define ModelUrl "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/" + ModelFile

[Setup]
AppId={{8F3C2B71-6E2D-4C6B-9B8A-5A1D2E7C4F10}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=MarkNotes
AppComments=Fast offline notepad with workspaces, code windows and transcription
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=..\..\installer
OutputBaseFilename=MarkNotes-Setup-{#AppVersion}
SetupIconFile=..\host\assets\app.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
Compression=lzma2/ultra64
SolidCompression=yes
LZMANumBlockThreads=4
WizardStyle=modern
WizardImageFile=wizard-large.bmp,wizard-large-2x.bmp
WizardSmallImageFile=wizard-small.bmp,wizard-small-2x.bmp
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
ChangesAssociations=yes
CloseApplications=yes
RestartApplications=no
; Always ask (English / Español); the language picked last time comes preselected.
ShowLanguageDialog=yes
VersionInfoVersion={#AppVersion}.0
VersionInfoProductName={#AppName}
VersionInfoDescription={#AppName} Setup

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"
Name: "es"; MessagesFile: "compiler:Languages\Spanish.isl"

[CustomMessages]
en.TypeFull=Full (notes + offline transcription)
es.TypeFull=Completa (notas + transcripción sin internet)
en.TypeCompact=Compact (notes only, smaller download)
es.TypeCompact=Compacta (solo notas, más liviana)
en.TypeCustom=Custom
es.TypeCustom=Personalizada
en.CompMain=MarkNotes
es.CompMain=MarkNotes
en.CompSpeech=Offline transcription engine (whisper.cpp for GPU and CPU, about 60 MB)
es.CompSpeech=Motor de transcripción sin internet (whisper.cpp para GPU y CPU, unos 60 MB)
en.TaskAssoc=Add MarkNotes to "Open with" for .md and .txt files
es.TaskAssoc=Agregar MarkNotes a "Abrir con" para archivos .md y .txt
en.GroupFiles=File types:
es.GroupFiles=Tipos de archivo:
en.GroupSpeech=Transcription:
es.GroupSpeech=Transcripción:
en.TaskModel=Download the speech model now ({#ModelLabel}, one time; covers Spanish, English and more). You can also do it later in Settings › Transcription.
es.TaskModel=Descargar ahora el modelo de voz ({#ModelLabel}, una sola vez; sirve para español, inglés y más). También podés hacerlo después en Configuración › Transcripción.
en.TaskModelPresent=Speech model already downloaded ({#ModelLabel}): it is kept and not downloaded again.
es.TaskModelPresent=El modelo de voz ya está descargado ({#ModelLabel}): se conserva y no se vuelve a descargar.
en.UpdateTitle=Update MarkNotes
es.UpdateTitle=Actualizar MarkNotes
en.UpdateSubtitle=MarkNotes %1 is already installed on this PC.
es.UpdateSubtitle=MarkNotes %1 ya está instalado en esta PC.
en.UpdateText=This setup updates it to version %2, in the same folder.%n%nThere is no need to uninstall the current version first: just click Next.%n%nYour notes and settings are not touched, and nothing is downloaded unless you choose to download the speech model (if you already have it, it is not downloaded again).
es.UpdateText=Este instalador lo actualiza a la versión %2, en la misma carpeta.%n%nNo hace falta desinstalar la versión actual: solo hacé clic en Siguiente.%n%nTus notas y tu configuración no se tocan, y no se descarga nada salvo que elijas descargar el modelo de voz (si ya lo tenés, no se vuelve a descargar).
en.ReinstallText=This setup installs version %2 again over it, in the same folder (to repair it, for example).%n%nThere is no need to uninstall it first: just click Next.%n%nYour notes and settings are not touched.
es.ReinstallText=Este instalador vuelve a instalar la versión %2 encima, en la misma carpeta (por ejemplo, para repararla).%n%nNo hace falta desinstalarla antes: solo hacé clic en Siguiente.%n%nTus notas y tu configuración no se tocan.
en.ModelDownloadFailed=The speech model could not be downloaded:%n%1%n%nMarkNotes is installed anyway; you can download the model later in Settings › Transcription.
es.ModelDownloadFailed=No se pudo descargar el modelo de voz:%n%1%n%nMarkNotes se instala igual; podés descargarlo después en Configuración › Transcripción.
en.NeedDotNet=MarkNotes needs the free Microsoft .NET 8 Desktop Runtime (x64), which is not installed on this PC.%n%nOpen the official download page now? (Install it, then start MarkNotes.)
es.NeedDotNet=MarkNotes necesita Microsoft .NET 8 Desktop Runtime (x64), que es gratis y no está instalado en esta PC.%n%n¿Abrir ahora la página oficial de descarga? (Instalalo y después abrí MarkNotes.)
en.NeedWebView=MarkNotes needs the Microsoft Edge WebView2 Runtime, which is not installed on this PC (Windows 11 already includes it).%n%nOpen the official download page now?
es.NeedWebView=MarkNotes necesita Microsoft Edge WebView2 Runtime, que no está instalado en esta PC (Windows 11 ya lo trae).%n%n¿Abrir ahora la página oficial de descarga?

[Types]
Name: "full"; Description: "{cm:TypeFull}"
Name: "compact"; Description: "{cm:TypeCompact}"
Name: "custom"; Description: "{cm:TypeCustom}"; Flags: iscustom

[Components]
Name: "main"; Description: "{cm:CompMain}"; Types: full compact custom; Flags: fixed
Name: "speech"; Description: "{cm:CompSpeech}"; Types: full

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "assoc"; Description: "{cm:TaskAssoc}"; GroupDescription: "{cm:GroupFiles}"
Name: "speechmodel"; Description: "{cm:TaskModel}"; GroupDescription: "{cm:GroupSpeech}"; Components: speech; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Excludes: "runtimes\*,*.xml,*.pdb"; Flags: recursesubdirs ignoreversion; Components: main
Source: "{#SourceDir}\runtimes\win-x64\native\*"; DestDir: "{app}\runtimes\win-x64\native"; Flags: ignoreversion; Components: main
Source: "{#SourceDir}\runtimes\win-x64\*.dll"; DestDir: "{app}\runtimes\win-x64"; Flags: ignoreversion; Components: speech
Source: "{#SourceDir}\runtimes\vulkan\*"; DestDir: "{app}\runtimes\vulkan"; Flags: recursesubdirs ignoreversion; Components: speech

[InstallDelete]
; Old web bundles from a previous version.
Type: filesandordirs; Name: "{app}\web"

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Registry]
Root: HKA; Subkey: "Software\Classes\MarkNotes.md"; ValueType: string; ValueData: "Markdown note"; Flags: uninsdeletekey; Tasks: assoc
Root: HKA; Subkey: "Software\Classes\MarkNotes.md\DefaultIcon"; ValueType: string; ValueData: """{app}\icons\note.ico"""; Tasks: assoc
Root: HKA; Subkey: "Software\Classes\MarkNotes.md\shell\open\command"; ValueType: string; ValueData: """{app}\{#AppExe}"" ""%1"""; Tasks: assoc
Root: HKA; Subkey: "Software\Classes\MarkNotes.txt"; ValueType: string; ValueData: "Text document"; Flags: uninsdeletekey; Tasks: assoc
Root: HKA; Subkey: "Software\Classes\MarkNotes.txt\DefaultIcon"; ValueType: string; ValueData: """{app}\icons\note.ico"""; Tasks: assoc
Root: HKA; Subkey: "Software\Classes\MarkNotes.txt\shell\open\command"; ValueType: string; ValueData: """{app}\{#AppExe}"" ""%1"""; Tasks: assoc
Root: HKA; Subkey: "Software\Classes\.md\OpenWithProgids"; ValueType: none; ValueName: "MarkNotes.md"; Flags: uninsdeletevalue; Tasks: assoc
Root: HKA; Subkey: "Software\Classes\.markdown\OpenWithProgids"; ValueType: none; ValueName: "MarkNotes.md"; Flags: uninsdeletevalue; Tasks: assoc
Root: HKA; Subkey: "Software\Classes\.txt\OpenWithProgids"; ValueType: none; ValueName: "MarkNotes.txt"; Flags: uninsdeletevalue; Tasks: assoc
Root: HKA; Subkey: "Software\Classes\Applications\{#AppExe}"; ValueType: string; ValueName: "FriendlyAppName"; ValueData: "{#AppName}"; Flags: uninsdeletekey; Tasks: assoc
Root: HKA; Subkey: "Software\Classes\Applications\{#AppExe}\shell\open\command"; ValueType: string; ValueData: """{app}\{#AppExe}"" ""%1"""; Tasks: assoc
Root: HKA; Subkey: "Software\Classes\Applications\{#AppExe}\SupportedTypes"; ValueType: string; ValueName: ".md"; ValueData: ""; Tasks: assoc
Root: HKA; Subkey: "Software\Classes\Applications\{#AppExe}\SupportedTypes"; ValueType: string; ValueName: ".markdown"; ValueData: ""; Tasks: assoc
Root: HKA; Subkey: "Software\Classes\Applications\{#AppExe}\SupportedTypes"; ValueType: string; ValueName: ".txt"; ValueData: ""; Tasks: assoc
Root: HKA; Subkey: "Software\MarkNotes\Capabilities"; ValueType: string; ValueName: "ApplicationName"; ValueData: "{#AppName}"; Flags: uninsdeletekey; Tasks: assoc
Root: HKA; Subkey: "Software\MarkNotes\Capabilities"; ValueType: string; ValueName: "ApplicationDescription"; ValueData: "Notes and code notepad"; Tasks: assoc
Root: HKA; Subkey: "Software\MarkNotes\Capabilities\FileAssociations"; ValueType: string; ValueName: ".md"; ValueData: "MarkNotes.md"; Tasks: assoc
Root: HKA; Subkey: "Software\MarkNotes\Capabilities\FileAssociations"; ValueType: string; ValueName: ".markdown"; ValueData: "MarkNotes.md"; Tasks: assoc
Root: HKA; Subkey: "Software\MarkNotes\Capabilities\FileAssociations"; ValueType: string; ValueName: ".txt"; ValueData: "MarkNotes.txt"; Tasks: assoc
Root: HKA; Subkey: "Software\RegisteredApplications"; ValueType: string; ValueName: "{#AppName}"; ValueData: "Software\MarkNotes\Capabilities"; Flags: uninsdeletevalue; Tasks: assoc

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[Code]
var
  DownloadPage: TDownloadWizardPage;

{ The app looks for speech models in %LOCALAPPDATA%\MarkNotes\models. }
function ModelTarget(): String;
begin
  Result := ExpandConstant('{localappdata}\MarkNotes\models\{#ModelFile}');
end;

function ModelInstalled(): Boolean;
var
  Size: Integer;
begin
  Result := FileSize(ModelTarget(), Size) and (Size = {#ModelSize});
end;

function OnDownloadProgress(const Url, FileName: String; const Progress, ProgressMax: Int64): Boolean;
begin
  Result := True;
end;

{ The version already installed in this install mode (Setup reuses the previous mode and folder), or ''. }
function PreviousVersion(): String;
var
  V: String;
begin
  Result := '';
  if RegQueryStringValue(HKA64, ExpandConstant('Software\Microsoft\Windows\CurrentVersion\Uninstall\{#emit SetupSetting("AppId")}_is1'), 'DisplayVersion', V) then
    Result := V;
end;

procedure InitializeWizard();
var
  Prev, Text: String;
begin
  DownloadPage := CreateDownloadPage(SetupMessage(msgWizardPreparing), SetupMessage(msgPreparingDesc), @OnDownloadProgress);
  { An update: say first that it goes over the installed version (no need to uninstall it). }
  Prev := PreviousVersion();
  if Prev <> '' then
  begin
    if Prev = '{#AppVersion}' then
      Text := CustomMessage('ReinstallText')
    else
      Text := CustomMessage('UpdateText');
    CreateOutputMsgPage(wpWelcome, CustomMessage('UpdateTitle'), FmtMessage(CustomMessage('UpdateSubtitle'), [Prev]), FmtMessage(Text, [Prev, '{#AppVersion}']));
  end;
end;

{ The speech model is already there: say so instead of offering to download it again. }
procedure CurPageChanged(CurPageID: Integer);
var
  I: Integer;
begin
  if (CurPageID = wpSelectTasks) and ModelInstalled() then
    for I := 0 to WizardForm.TasksList.Items.Count - 1 do
      if WizardForm.TasksList.ItemCaption[I] = CustomMessage('TaskModel') then
      begin
        WizardForm.TasksList.Checked[I] := False;
        WizardForm.TasksList.ItemEnabled[I] := False;
        WizardForm.TasksList.ItemCaption[I] := CustomMessage('TaskModelPresent');
      end;
end;

{ Interactive installs: download (with progress bar and SHA-256 check) right after "Install" is clicked. }
function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = wpReady) and WizardIsTaskSelected('speechmodel') and not ModelInstalled() then
  begin
    DownloadPage.Clear;
    DownloadPage.Add('{#ModelUrl}', '{#ModelFile}', '{#ModelSha}');
    DownloadPage.Show;
    try
      try
        DownloadPage.Download;
      except
        if not DownloadPage.AbortedByUser then
          SuppressibleMsgBox(FmtMessage(CustomMessage('ModelDownloadFailed'), [GetExceptionMessage]), mbError, MB_OK, IDOK);
      end;
    finally
      DownloadPage.Hide;
    end;
  end;
end;

procedure PlaceModel();
var
  Src, Dst: String;
begin
  Src := ExpandConstant('{tmp}\{#ModelFile}');
  Dst := ModelTarget();
  if not FileExists(Src) then
    Exit;
  ForceDirectories(ExtractFileDir(Dst));
  if FileExists(Dst) then
    DeleteFile(Dst);
  if not RenameFile(Src, Dst) then
    if not FileCopy(Src, Dst, False) then
      Log('Could not place the speech model in ' + Dst);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and WizardIsTaskSelected('speechmodel') then
  begin
    { Silent installs never show the download page, so fetch it here. }
    if WizardSilent() and not ModelInstalled() and not FileExists(ExpandConstant('{tmp}\{#ModelFile}')) then
    begin
      try
        DownloadTemporaryFile('{#ModelUrl}', '{#ModelFile}', '{#ModelSha}', @OnDownloadProgress);
      except
        Log('Speech model download failed: ' + GetExceptionMessage);
      end;
    end;
    PlaceModel();
  end;
end;

function HasDotNetDesktop8(): Boolean;
var
  FindRec: TFindRec;
begin
  Result := False;
  if FindFirst(ExpandConstant('{commonpf64}\dotnet\shared\Microsoft.WindowsDesktop.App\8.*'), FindRec) then
  begin
    Result := True;
    FindClose(FindRec);
  end;
end;

function HasWebView2(): Boolean;
var
  V: String;
begin
  Result :=
    (RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', V) and (V <> '') and (V <> '0.0.0.0')) or
    (RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', V) and (V <> '') and (V <> '0.0.0.0'));
end;

function InitializeSetup(): Boolean;
var
  Code: Integer;
begin
  Result := True;
  if not HasDotNetDesktop8() then
  begin
    if SuppressibleMsgBox(CustomMessage('NeedDotNet'), mbConfirmation, MB_YESNO, IDNO) = IDYES then
      ShellExec('open', 'https://dotnet.microsoft.com/download/dotnet/8.0', '', '', SW_SHOWNORMAL, ewNoWait, Code);
  end;
  if not HasWebView2() then
  begin
    if SuppressibleMsgBox(CustomMessage('NeedWebView'), mbConfirmation, MB_YESNO, IDNO) = IDYES then
      ShellExec('open', 'https://developer.microsoft.com/microsoft-edge/webview2/', '', '', SW_SHOWNORMAL, ewNoWait, Code);
  end;
end;
