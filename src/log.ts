import * as vscode from 'vscode';
import { Logger } from './fusion/types';

/** Output-channel logger. Debug lines only appear when `fusionSqlDev.debugLogging` is on. Never logs credentials or data. */
export class OutputLogger implements Logger {
  private readonly channel = vscode.window.createOutputChannel('Fusion SQL DEV');

  private write(level: string, msg: string): void {
    this.channel.appendLine(`${new Date().toISOString()} [${level}] ${msg}`);
  }
  debug(msg: string): void {
    if (vscode.workspace.getConfiguration('fusionSqlDev').get<boolean>('debugLogging')) {
      this.write('debug', msg);
    }
  }
  info(msg: string): void {
    this.write('info', msg);
  }
  warn(msg: string): void {
    this.write('warn', msg);
  }
  error(msg: string): void {
    this.write('error', msg);
  }
  show(): void {
    this.channel.show(true);
  }
  dispose(): void {
    this.channel.dispose();
  }
}
