# Disassembly view using DAP

![](https://raw.githubusercontent.com/nextarg/disassembly-view/main/images/disassembly-view.gif)

# Limitations

- You need to display the Watch expression.
- There must be at least one Watch expression.  
  The Watch expression to be added can be a non-existent value. (Ex: aaaaaa)

![](https://raw.githubusercontent.com/nextarg/disassembly-view/main/images/watch.png)

# Execution Requirements

- Debug adapter with disassembly and memoryReference support.

If you are using mingw+gdb with vscode-cpptools, you probably need to update MIEngine.

# Usage

1. Start debugging and break.
2. If the Watch expression does not exist, add it.
3. Execute **Disassembly** command from the the command palette.
4. Enter an address or symbol in **Address:** and press ENTER.
5. You can use the mouse wheel, up key, and down key to scroll.

# Features

## Go To Disassembly

:warning: The debug adapter requires support for *gotoTargets* requests and support for *instructionPointerReference*.

Select **Go To Disassembly** from the editor's context menu.

![](https://raw.githubusercontent.com/nextarg/disassembly-view/main/images/goto-disassembly.gif)

## Go To Source

:warning: The source information must be included in the disassembly information.

Select **Go To Source** from the disassembly view context menu.

![](https://raw.githubusercontent.com/nextarg/disassembly-view/main/images/goto-source.gif)
