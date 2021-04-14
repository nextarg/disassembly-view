import * as vscode from 'vscode';
import { DebugProtocol } from 'vscode-debugprotocol'
import * as path from 'path';
import * as fs from 'fs';


export class DisassemblyView {
  private static frameId = 0;
  private static disassembling = false;
  private static currentPanel: DisassemblyView | undefined;
  private static readonly viewType = 'nextarg.DisassemblyView';
  private static readonly title = 'DisassemblyView';
  private static dbgMode: string;
  private static gdbPyScript: string;
  private static isLocationResolutionEnabled: boolean | undefined;
  private static capabilities = new Map();

  private disposables: vscode.Disposable[] = [];

  public static register(context: vscode.ExtensionContext) {
    DisassemblyView.isLocationResolutionEnabled = vscode.workspace.getConfiguration().get('disassembly.resolveLocations');
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('disassembly.resolveLocations')) {
        DisassemblyView.isLocationResolutionEnabled = vscode.workspace.getConfiguration().get('disassembly.resolveLocations');
      }
    }));

    DisassemblyView.gdbPyScript = path.join(context.extensionPath, 'scripts', 'gdb', 'utils.py');

    context.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory('*', {
      createDebugAdapterTracker(session) {
        return {
          onWillReceiveMessage: m => {
            switch (m.command) {
              case 'evaluate':
                if (m.arguments.context === 'watch') {
                  DisassemblyView.onEvaluateWatch(m.arguments);
                }
                break;
            }
          },
          onDidSendMessage: m => {
            switch (m.event) {
              case 'stopped':
              case 'continued':
                DisassemblyView.onModeChange(m);
                break;
            }
            switch (m.command) {
              case 'initialize':
                DisassemblyView.capabilities.set(session.id, m.body);
                break;
            }
          },
          onWillStopSession: () => {
            DisassemblyView.capabilities.delete(session.id);
          }
        };
      }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('nextarg.disassembly-view.disassembly', () => {
      DisassemblyView.show(context, context.extensionUri);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('nextarg.disassembly-view.gotoDisassembly', () => {
      if (!vscode.debug.activeDebugSession) {
        return;
      }
      let debugSession = vscode.debug.activeDebugSession;
      if (!DisassemblyView.debugSessionHasCapability(debugSession, 'supportsDisassembleRequest') ||
        !DisassemblyView.debugSessionHasCapability(debugSession, 'supportsGotoTargetsRequest')) {
        vscode.window.showErrorMessage('Unsupported DA');
        return;
      }

      let gotoTargetsRequest: DebugProtocol.GotoTargetsArguments = {
        source: {
          path: vscode.window.activeTextEditor?.document.fileName
        },
        line: 0
      };
      if (vscode.window.activeTextEditor) {
        gotoTargetsRequest.line = vscode.window.activeTextEditor.selection.active.line + 1;
      }
      debugSession.customRequest('gotoTargets', gotoTargetsRequest).then((gotoTargetsResponse) => {
        DisassemblyView.show(context, context.extensionUri);
        DisassemblyView.currentPanel?.panel.webview.postMessage({
          command: 'disassemble', arguments: {
            memoryReference: gotoTargetsResponse.targets[0].instructionPointerReference
          }
        });
      }, (error) => {
        vscode.window.showErrorMessage(error.message);
      });
    }));
  }

  public static show(context: vscode.ExtensionContext, extensionUri: vscode.Uri) {
    const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

    if (DisassemblyView.currentPanel) {
      DisassemblyView.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      DisassemblyView.viewType,
      DisassemblyView.title,
      column || vscode.ViewColumn.One,
      {
        retainContextWhenHidden: true,
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'build'))]
      }
    );

    DisassemblyView.currentPanel = new DisassemblyView(context, panel, extensionUri);
  }

  private static onEvaluateWatch(args: any) {
    DisassemblyView.frameId = args.frameId;
  }

  private static onModeChange(message: any) {
    DisassemblyView.dbgMode = message.event;
  }

  private static debugSessionHasCapability(debugSession: vscode.DebugSession | undefined,
    capability: 'supportsDisassembleRequest' | 'supportsGotoTargetsRequest'): boolean {
    if (DisassemblyView.capabilities.has(debugSession?.id)) {
      let capabilities = DisassemblyView.capabilities.get(debugSession?.id);
      if (capabilities.hasOwnProperty(capability) && capabilities[capability]) {
        return true;
      }
    }
    return false;
  }

  // ****************************************************************************************************

  private constructor(private context: vscode.ExtensionContext, private panel: vscode.WebviewPanel, private extensionUri: vscode.Uri) {
    const extensionPath = context.extensionPath;

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.onDidChangeViewState(
      e => {
        if (this.panel.visible) {
          this.setPC(vscode.debug.activeDebugSession);
        }
      },
      null,
      this.disposables
    );

    panel.webview.html = this.getWebviewContent(extensionPath);

    panel.webview.onDidReceiveMessage(
      message => {
        switch (message.command) {
          case 'disassemble':
            this.disassemble(vscode.debug.activeDebugSession, message.arguments);
            return;
          case 'gotoSource':
            vscode.workspace.openTextDocument(vscode.Uri.file(message.arguments.path)).then(doc => {
              let pos = new vscode.Position(message.arguments.endLine - 1, 0);
              let options: vscode.TextDocumentShowOptions = {
                selection: new vscode.Range(pos, pos)
              };
              vscode.window.showTextDocument(doc, options);
            });
            return;
        }
      },
      undefined,
      context.subscriptions
    );

  }

  private async disassemble(debugSession: vscode.DebugSession | undefined, args: DebugProtocol.DisassembleArguments) {
    if (!debugSession) {
      vscode.window.showErrorMessage('ERR:debugging session');
      return;
    }
    if (!DisassemblyView.debugSessionHasCapability(debugSession, 'supportsDisassembleRequest')) {
      vscode.window.showErrorMessage('Unsupported DA');
      return;
    }
    if (DisassemblyView.disassembling) {
      return;
    }
    if (DisassemblyView.dbgMode !== 'stopped') {
      vscode.window.showErrorMessage('The application is running.');
      return;
    }

    let onError = (error: string) => {
      vscode.window.showErrorMessage(error);
      DisassemblyView.disassembling = false;
    }

    DisassemblyView.disassembling = true;

    this.setPC(debugSession);
    try {
      let evaluateArguments: DebugProtocol.EvaluateArguments = {
        expression: args.memoryReference,
        context: 'repl',
        frameId: DisassemblyView.frameId,
      };
      const evaluateResponse = await debugSession.customRequest('evaluate', evaluateArguments);

      if (!evaluateResponse.memoryReference) {
        onError(evaluateResponse.result);
        return;
      }

      let disasmInternal = async (memoryReference: string, instructionOffset: number, instructionCount: number) => {
        if (memoryReference) {
          let disassembleArguments: DebugProtocol.DisassembleArguments = {
            memoryReference: memoryReference,
            instructionOffset: instructionOffset,
            instructionCount: instructionCount,
          };
          const disassembleResponse = await debugSession?.customRequest('disassemble', disassembleArguments);

          await this.resolveLocations(debugSession, disassembleResponse.instructions);

          this.panel.webview.postMessage({ command: 'update', instructions: disassembleResponse.instructions });
        }
        DisassemblyView.disassembling = false;
      };

      let address = evaluateResponse.memoryReference;
      let instructionOffset = args.instructionOffset ?? 0;
      let instructionCount = args.instructionCount;

      if (0 === +address && instructionOffset < 0) {
        instructionOffset = 0;
      }
      if (debugSession.type === 'cppvsdbg' && instructionOffset < 0) {
        let fetcheInstCount = 8;
        const i = +address - fetcheInstCount;
        if (i < 0) {
          fetcheInstCount += i;
        }
        let disassembleArguments: DebugProtocol.DisassembleArguments = {
          memoryReference: address,
          instructionOffset: -fetcheInstCount,
          instructionCount: fetcheInstCount + 1,
          resolveSymbols: false
        };
        const disassembleResponse = await debugSession.customRequest('disassemble', disassembleArguments);
        if (disassembleResponse.instructions[disassembleResponse.instructions.length - 1].address == evaluateResponse.memoryReference) {
          disasmInternal(disassembleResponse.instructions[disassembleResponse.instructions.length - 2].address, 0, instructionCount);
        } else {
          onError('ERR:addr');
        }
      } else {
        disasmInternal(address, instructionOffset, instructionCount);
      }
    } catch (error) {
      onError(error.message);
    }
  }

  private async loadGDBScriptIfNecessary(debugSession: vscode.DebugSession | undefined) {
    let evaluateArguments: DebugProtocol.EvaluateArguments = {
      expression: '$get_location',
      context: 'repl',
      frameId: DisassemblyView.frameId,
    };
    const evaluateResponse = await debugSession?.customRequest('evaluate', evaluateArguments);
    if (evaluateResponse.type !== '<internal function>') {
      let evaluateArguments: DebugProtocol.EvaluateArguments = {
        expression: '-exec source ' + DisassemblyView.gdbPyScript,
        context: 'repl',
        frameId: DisassemblyView.frameId,
      };
      await debugSession?.customRequest('evaluate', evaluateArguments);
    }
  }

  private async resolveLocations_GDB(debugSession: vscode.DebugSession | undefined, instructions: any) {
    await this.loadGDBScriptIfNecessary(debugSession);

    const addrs = instructions?.map((inst: any) => inst.address);
    let evaluateArguments: DebugProtocol.EvaluateArguments = {
      expression: '$resolve_locations(' + addrs.join(',') + ')',
      context: 'repl',
      frameId: DisassemblyView.frameId,
    };
    const evaluateResponse = await debugSession?.customRequest('evaluate', evaluateArguments);
    let variablesArguments: DebugProtocol.VariablesArguments = {
      variablesReference: evaluateResponse.variablesReference
    }
    const variablesResponse = await debugSession?.customRequest('variables', variablesArguments);
    let b = variablesResponse.variables.reduce((accumulator: string, currentValue: DebugProtocol.Variable) => {
      return accumulator + currentValue.value.slice(-2, -1);
    }, '');

    let validAddressList;
    try {
      let addrsStr = Buffer.from(b, 'base64').toString();
      validAddressList = JSON.parse(addrsStr);
    }
    catch (error) {
    }

    if (Array.isArray(validAddressList) && validAddressList.length) {
      let validAddressSet = new Set(validAddressList);
      for (let i = 0; i < instructions?.length; ++i) {
        let inst = instructions[i];
        if (!inst.location && validAddressSet.has(+inst.address)) {
          let evaluateArguments: DebugProtocol.EvaluateArguments = {
            expression: '$get_location(' + inst.address + ')',
            context: 'repl',
            frameId: DisassemblyView.frameId,
          };
          const evaluateResponse = await debugSession?.customRequest('evaluate', evaluateArguments);

          if (!evaluateResponse.result) {
            continue
          }

          let variablesArguments: DebugProtocol.VariablesArguments = {
            variablesReference: evaluateResponse.variablesReference
          }
          const variablesResponse = await debugSession?.customRequest('variables', variablesArguments);
          let b = variablesResponse.variables.reduce((accumulator: string, currentValue: DebugProtocol.Variable) => {
            return accumulator + currentValue.value.slice(-2, -1);
          }, '');

          try {
            const locationObj = JSON.parse(Buffer.from(b, 'base64').toString());
            if (+locationObj.pc == +inst.address && locationObj.line) {
              inst.line = inst.endLine = +locationObj.line;
              let source: DebugProtocol.Source = {
                path: locationObj.fullname,
                name: locationObj.filename
              };
              inst.location = source;
            }
          }
          catch (error) {
          }
        }
      }
    }
  }

  private async resolveLocations(debugSession: vscode.DebugSession | undefined, instructions: any) {
    if (!DisassemblyView.isLocationResolutionEnabled) {
      return;
    }
    if (Array.isArray(instructions) && instructions.length) {
      if (debugSession?.type === 'cppdbg' && debugSession?.configuration.MIMode === 'gdb') {
        await this.resolveLocations_GDB(debugSession, instructions);
      }
    }
  }

  private async setPC(debugSession: vscode.DebugSession | undefined) {
    if (debugSession?.type === 'cppvsdbg' || debugSession?.type === 'cppdbg') {
      if (debugSession?.type === 'cppdbg' && debugSession?.configuration.MIMode != 'gdb') {
        return;
      }

      try {
        let evaluateArguments: DebugProtocol.EvaluateArguments = {
          expression: '$rip',
          context: 'repl',
          frameId: DisassemblyView.frameId,
        };
        const evaluateResponse = await debugSession?.customRequest('evaluate', evaluateArguments);
        if (evaluateResponse.memoryReference) {
          this.panel.webview.postMessage({ command: 'setPC', pc: evaluateResponse.memoryReference });
        } else {
          let evaluateArguments: DebugProtocol.EvaluateArguments = {
            expression: '$eip',
            context: 'repl',
            frameId: DisassemblyView.frameId,
          };
          const evaluateResponse = await debugSession?.customRequest('evaluate', evaluateArguments);
          if (evaluateResponse.memoryReference) {
            this.panel.webview.postMessage({ command: 'setPC', pc: evaluateResponse.memoryReference });
          }
        }
      } catch (error) {
        vscode.window.showErrorMessage(error.message);
      }
    }
  }

  public dispose() {
    DisassemblyView.currentPanel = undefined;

    this.panel.dispose();

    while (this.disposables.length) {
      const x = this.disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  private getWebviewContent(extensionPath: string) {
    const nonce = this.getNonce();
    const manifestFile = path.join(extensionPath, 'build', 'asset-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const mainScript = manifest['files']['main.js'];
    const mainStyle = manifest['files']['main.css'];
    const scriptPathOnDisk = vscode.Uri.file(path.join(extensionPath, 'build', mainScript));
    const scriptUri = this.panel.webview.asWebviewUri(scriptPathOnDisk);
    const stylePathOnDisk = vscode.Uri.file(path.join(extensionPath, 'build', mainStyle));
    const styleUri = this.panel.webview.asWebviewUri(stylePathOnDisk);

    return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
                <meta name="theme-color" content="#000000">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-resource:; script-src 'nonce-${nonce}';style-src vscode-resource: 'unsafe-inline';">
                <title>React App</title>
                <base href="${vscode.Uri.file(path.join(extensionPath, 'build')).with({ scheme: 'vscode-resource' })}/">
                <link rel="stylesheet" type="text/css" href="${styleUri}">
            </head>

            <body>
                <noscript>You need to enable JavaScript to run this app.</noscript>
                <div id="root"></div>
                <script nonce="${nonce}" src="${scriptUri}"></script>
            </body>
            </html>`;
  }

  private getNonce() {
    let text = "";
    const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
