import type { Config } from "./config.js";
import { parseEncryptionKey } from "./crypto.js";
import type { Db } from "./db/index.js";
import type { Logger } from "./logger.js";
import { ComprobanteRepo } from "./sire/comprobantes.js";
import { JobQueue } from "./sire/jobs.js";
import { TenantRepo } from "./sire/tenants.js";
import { TicketService } from "./sire/tickets.js";
import { Worker } from "./sire/worker.js";
import type { FileStorage } from "./storage.js";
import { Guards } from "./sunat/guard.js";
import { SunatHttp } from "./sunat/http.js";
import { SireClient } from "./sunat/sire.js";
import { TokenService } from "./sunat/tokens.js";

export interface Container {
  cfg: Config;
  db: Db;
  log: Logger;
  guards: Guards;
  tokens: TokenService;
  sire: SireClient;
  tenants: TenantRepo;
  queue: JobQueue;
  comprobantes: ComprobanteRepo;
  tickets: TicketService;
  worker: Worker;
  storage: FileStorage;
}

export interface Extras {
  /** Para pruebas: reemplaza `fetch` (así SUNAT es un servidor falso en memoria). */
  fetchImpl?: typeof fetch;
  /** Para pruebas: no esperar entre llamadas. */
  dormirFn?: (ms: number) => Promise<void>;
}

/** Arma todas las piezas conectadas entre sí. Un solo lugar donde se ve de qué depende cada cosa. */
export function crearContenedor(cfg: Config, db: Db, log: Logger, storage: FileStorage, extras: Extras = {}): Container {
  const guards = new Guards(cfg);
  const tokens = new TokenService(cfg, guards, extras.fetchImpl, undefined, log);
  const http = new SunatHttp(cfg, tokens, guards, log, extras.fetchImpl, extras.dormirFn);
  const sire = new SireClient(http);
  const tenants = new TenantRepo(db, parseEncryptionKey(cfg.APP_ENCRYPTION_KEY), cfg.API_KEY_PEPPER);
  const queue = new JobQueue(db);
  const comprobantes = new ComprobanteRepo(db);
  const tickets = new TicketService({ db, sire, queue, tenants, comprobantes, storage, log, maxSondeos: cfg.TICKET_MAX_POLLS, primerSondeoMs: cfg.TICKET_FIRST_POLL_MS });
  const worker = new Worker({
    queue,
    tickets,
    log,
    maxSondeos: cfg.TICKET_MAX_POLLS,
    intervaloMs: cfg.WORKER_INTERVAL_MS,
    esperaFijaMs: cfg.TICKET_POLL_INTERVAL_MS,
  });
  return { cfg, db, log, guards, tokens, sire, tenants, queue, comprobantes, tickets, worker, storage };
}
