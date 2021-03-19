import * as vscode from 'vscode';
import { DisassemblyView } from './disassemblyView'

class Extension {
  constructor(context: vscode.ExtensionContext) {
    DisassemblyView.register(context);
  }
}

export function activate(context: vscode.ExtensionContext) {
  let extension = new Extension(context);
}

export function deactivate() {
}
