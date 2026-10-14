import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Connection, EnvironmentType } from '../model';
import { Logger } from '../fusion/types';
import { normalizeBaseUrl } from '../fusion/bip';
import { TokenSet, TokenStore } from '../auth/oauth';

const KEY_CONNECTIONS = 'fusionSqlDev.connections';
const KEY_ACTIVE = 'fusionSqlDev.activeConnection';
const KEY_MIGRATED = 'fusionSqlDev.legacyMigrated';

const secretKey = {
  password: (id: string) => `fusionSqlDev.password.${id}`,
  clientSecret: (id: string) => `fusionSqlDev.clientSecret.${id}`,
  oauthTokens: (id: string) => `fusionSqlDev.oauthTokens.${id}`,
  pasted: (id: string) => `fusionSqlDev.pasted.${id}`
};

interface LegacyConnection {
  id: string;
  name: string;
  host: string;
  username: string;
  environmentType?: string;
  encoded_p?: string;
}

export class ConnectionStore {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly log: Logger
  ) {}

  // ------------------------------------------------------------------ CRUD

  list(): Connection[] {
    return this.ctx.globalState.get<Connection[]>(KEY_CONNECTIONS, []);
  }

  get(id: string | undefined): Connection | undefined {
    return id ? this.list().find((c) => c.id === id) : undefined;
  }

  async save(conn: Connection): Promise<void> {
    const all = this.list();
    const i = all.findIndex((c) => c.id === conn.id);
    if (i >= 0) {
      all[i] = conn;
    } else {
      all.push(conn);
    }
    await this.ctx.globalState.update(KEY_CONNECTIONS, all);
    this.emitter.fire();
  }

  /** Update non-secret bookkeeping fields without clobbering concurrent edits. */
  async patch(id: string, patch: Partial<Connection>): Promise<void> {
    const c = this.get(id);
    if (c) {
      await this.save({ ...c, ...patch });
    }
  }

  async delete(id: string): Promise<void> {
    await this.ctx.globalState.update(
      KEY_CONNECTIONS,
      this.list().filter((c) => c.id !== id)
    );
    await Promise.all(Object.values(secretKey).map((k) => this.ctx.secrets.delete(k(id))));
    if (this.activeId === id) {
      await this.setActive(undefined);
    }
    this.emitter.fire();
  }

  get activeId(): string | undefined {
    return this.ctx.globalState.get<string>(KEY_ACTIVE);
  }

  get active(): Connection | undefined {
    return this.get(this.activeId);
  }

  async setActive(id: string | undefined): Promise<void> {
    await this.ctx.globalState.update(KEY_ACTIVE, id);
    await vscode.commands.executeCommand('setContext', 'fusionSqlDev.hasActiveConnection', !!id);
    this.emitter.fire();
  }

  // --------------------------------------------------------------- secrets

  getPassword(id: string): Thenable<string | undefined> {
    return this.ctx.secrets.get(secretKey.password(id));
  }
  setPassword(id: string, v: string): Thenable<void> {
    return this.ctx.secrets.store(secretKey.password(id), v);
  }
  getClientSecret(id: string): Thenable<string | undefined> {
    return this.ctx.secrets.get(secretKey.clientSecret(id));
  }
  setClientSecret(id: string, v: string | undefined): Thenable<void> {
    return v ? this.ctx.secrets.store(secretKey.clientSecret(id), v) : this.ctx.secrets.delete(secretKey.clientSecret(id));
  }
  getPasted(id: string): Thenable<string | undefined> {
    return this.ctx.secrets.get(secretKey.pasted(id));
  }
  setPasted(id: string, v: string): Thenable<void> {
    return this.ctx.secrets.store(secretKey.pasted(id), v);
  }

  tokenStore(id: string): TokenStore {
    const secrets = this.ctx.secrets;
    return {
      async load(): Promise<TokenSet | undefined> {
        const raw = await secrets.get(secretKey.oauthTokens(id));
        if (!raw) {
          return undefined;
        }
        try {
          return JSON.parse(raw) as TokenSet;
        } catch {
          return undefined;
        }
      },
      async save(t: TokenSet): Promise<void> {
        await secrets.store(secretKey.oauthTokens(id), JSON.stringify(t));
      },
      async clear(): Promise<void> {
        await secrets.delete(secretKey.oauthTokens(id));
      }
    };
  }

  // ------------------------------------------------------------- migration

  /**
   * Version 1.x kept profiles (with a *base64 copy of the password*) in ~/FusionDev/Connections/connections.json.
   * Move them into globalState + SecretStorage, then scrub the passwords from that file.
   */
  async migrateLegacy(): Promise<number> {
    if (this.ctx.globalState.get<boolean>(KEY_MIGRATED)) {
      return 0;
    }
    const file = path.join(os.homedir(), 'FusionDev', 'Connections', 'connections.json');
    let imported = 0;
    try {
      if (fs.existsSync(file)) {
        const legacy = JSON.parse(fs.readFileSync(file, 'utf8')) as LegacyConnection[];
        let scrubbed = false;
        for (const l of legacy) {
          if (!l?.id || !l.host) {
            continue;
          }
          if (!this.get(l.id)) {
            let url: string;
            try {
              url = normalizeBaseUrl(l.host);
            } catch {
              continue;
            }
            const env = (['DEV', 'TEST', 'UAT', 'PROD'] as const).includes(l.environmentType as 'DEV') ? (l.environmentType as EnvironmentType) : 'DEV';
            await this.save({ id: l.id, name: l.name || url, url, username: l.username, auth: 'basic', environment: env, createdAt: Date.now() });
            let pass = await this.ctx.secrets.get(`fusion_dev_${l.id}`);
            if (!pass && l.encoded_p) {
              pass = Buffer.from(l.encoded_p, 'base64').toString('utf8');
            }
            if (pass) {
              await this.setPassword(l.id, pass);
            }
            imported++;
          }
          if (l.encoded_p) {
            delete l.encoded_p;
            scrubbed = true;
          }
        }
        if (scrubbed) {
          try {
            fs.writeFileSync(file, JSON.stringify(legacy, null, 2), 'utf8');
          } catch (e) {
            this.log.warn(`Could not scrub passwords from legacy file: ${(e as Error).message}`);
          }
        }
      }
    } catch (e) {
      this.log.warn(`Legacy connection import failed: ${(e as Error).message}`);
    }
    await this.ctx.globalState.update(KEY_MIGRATED, true);
    if (imported > 0) {
      this.log.info(`Imported ${imported} connection(s) from version 1.x`);
      this.emitter.fire();
    }
    return imported;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
