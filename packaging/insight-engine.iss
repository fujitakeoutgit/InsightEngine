; Inno Setup script for Insight Engine.
;
; Packages the PyInstaller onedir output into a single Setup.exe. Built by
; packaging\build-release.ps1, which runs the web build and PyInstaller first;
; this file assumes dist\InsightEngine already exists.
;
; Per-user install by design. It keeps the whole thing out of Program Files and
; out of UAC, which for a tool handed to friends means the installer just runs
; rather than raising a prompt that makes people close it.

#define AppName        "Insight Engine"
; Overridable from the command line: build-release.ps1 passes /DAppVersion=…
; so the version lives in one place. The default is only for compiling this
; file directly.
#ifndef AppVersion
  #define AppVersion    "1.0.0"
#endif
#define AppPublisher    "Insight Engine"
#define AppExe          "InsightEngine.exe"
#define AppUrl          "https://github.com/fujitakeoutgit/manafold"

[Setup]
AppId={{8F3C6A1E-4C7B-4E2A-9E43-2C1D7B5A9E10}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppSupportURL={#AppUrl}
DefaultDirName={localappdata}\Programs\InsightEngine
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
; No admin rights: see the note at the top.
PrivilegesRequired=lowest
OutputDir=..\release
OutputBaseFilename=InsightEngine-{#AppVersion}-Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#AppExe}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"
Name: "startup"; Description: "Start Insight Engine when I sign in"; GroupDescription: "Shortcuts:"; Flags: unchecked

[Files]
; The whole PyInstaller folder: the executable, the Python runtime, the built
; interface and the seed deck.
Source: "..\dist\InsightEngine\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon
Name: "{userstartup}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: startup

[Run]
; Unchecked by default. The first launch downloads about 180MB of card data,
; and starting that inside the installer would make "Finish" mean "wait four
; more minutes" with no way back.
Filename: "{app}\{#AppExe}"; Description: "Start {#AppName} now"; Flags: nowait postinstall skipifsilent unchecked

[UninstallDelete]
; PyInstaller's runtime leaves __pycache__ behind; without this the install
; folder survives uninstall and looks like a failed removal. Only {app} --
; the card mirror and saved decks live in LOCALAPPDATA and are deliberately
; left alone, so reinstalling does not throw away someone's decks.
Type: filesandordirs; Name: "{app}"

[Messages]
; The card data is not in this package and the first run is long, so say so
; before somebody waits at a blank screen wondering.
FinishedLabel=Insight Engine is installed.%n%nThe first launch downloads about 35MB of card data from Scryfall and takes a few minutes to index it. It only happens once.%n%nCard data and images are from Scryfall. Insight Engine is unofficial Fan Content permitted under the Wizards of the Coast Fan Content Policy.
