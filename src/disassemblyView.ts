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

  private disposables: vscode.Disposable[] = [];

  public static register(context: vscode.ExtensionContext) {
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
          },
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

      let gotoTargetsRequest: DebugProtocol.GotoTargetsArguments = {
        source: {
          path: vscode.window.activeTextEditor?.document.fileName
        },
        line: 0
      };
      if (vscode.window.activeTextEditor) {
        gotoTargetsRequest.line = vscode.window.activeTextEditor.selection.active.line + 1;
      }
      vscode.debug.activeDebugSession.customRequest('gotoTargets', gotoTargetsRequest).then((gotoTargetsResponse) => {
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

  // ****************************************************************************************************

  private constructor(private context: vscode.ExtensionContext, private panel: vscode.WebviewPanel, private extensionUri: vscode.Uri) {
    const extensionPath = context.extensionPath;

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.onDidChangeViewState(
      e => {
        if (this.panel.visible) {
          this.setPC();
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
            this.disassemble(message.arguments);
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

  private async disassemble(args: DebugProtocol.DisassembleArguments) {
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

    let onDebugSessionError = () => {
      onError('ERR:debugging session');
    }

    DisassemblyView.disassembling = true;
    if (!vscode.debug.activeDebugSession) {
      onDebugSessionError();
      return;
    }

    this.setPC();
    try {
      let evaluateArguments: DebugProtocol.EvaluateArguments = {
        expression: args.memoryReference,
        context: 'repl',
        frameId: DisassemblyView.frameId,
      };
      const evaluateResponse = await vscode.debug.activeDebugSession.customRequest('evaluate', evaluateArguments);

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
          const disassembleResponse = await vscode.debug.activeDebugSession?.customRequest('disassemble', disassembleArguments);
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
      if (vscode.debug.activeDebugSession.type === 'cppvsdbg' && instructionOffset < 0) {
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
        const disassembleResponse = await vscode.debug.activeDebugSession.customRequest('disassemble', disassembleArguments);
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

  private async setPC() {
    if (vscode.debug.activeDebugSession?.type === 'cppvsdbg' || vscode.debug.activeDebugSession?.type === 'cppdbg') {
      if (vscode.debug.activeDebugSession?.type === 'cppdbg' && vscode.debug.activeDebugSession?.configuration.MIMode != 'gdb') {
        return;
      }

      try {
        let evaluateArguments: DebugProtocol.EvaluateArguments = {
          expression: '$rip',
          context: 'repl',
          frameId: DisassemblyView.frameId,
        };
        const evaluateResponse = await vscode.debug.activeDebugSession?.customRequest('evaluate', evaluateArguments);
        if (evaluateResponse.memoryReference) {
          this.panel.webview.postMessage({ command: 'setPC', pc: evaluateResponse.memoryReference });
        } else {
          let evaluateArguments: DebugProtocol.EvaluateArguments = {
            expression: '$eip',
            context: 'repl',
            frameId: DisassemblyView.frameId,
          };
          const evaluateResponse = await vscode.debug.activeDebugSession?.customRequest('evaluate', evaluateArguments);
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
