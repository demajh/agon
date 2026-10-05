import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Variant } from './types.js';

/** The verification code every control-variant user must type. Shown in a dev hint on the page. */
export const DEV_VERIFICATION_CODE = '482913';
/** An address that is always registered, so signup can show a realistic "already taken" error. */
export const TAKEN_EMAIL = 'taken@example.com';

export interface Profile {
  role: string;
  teamSize: string;
}

export interface BankConnection {
  bank: string;
  connectedAt: string;
}

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  company: string;
  createdAt: string;
  /** Variant that was active when the account was created. */
  signupVariant: Variant;
  verified: boolean;
  profile?: Profile;
  bank?: BankConnection;
  bankSkipped: boolean;
  invites: string[];
  /** The invite step was submitted (possibly with no addresses). */
  inviteStepDone: boolean;
}

export interface Project {
  id: string;
  userId: string;
  name: string;
  currency: string;
  createdAt: string;
  /** Variant that was active when the project was created. */
  variant: Variant;
}

/** A product event queued server-side and emitted by the browser shim on the next rendered page. */
export interface ClientEvent {
  event: string;
  properties: Record<string, unknown>;
}

export interface Session {
  id: string;
  userId?: string;
  createdAt: string;
  signupStarted: boolean;
  pendingClientEvents: ClientEvent[];
}

/** One entry of the server-side event log served at GET /__events. Mirrors the PostHog event shape. */
export interface LoggedEvent {
  id: string;
  event: string;
  distinct_id: string;
  timestamp: string;
  properties: Record<string, unknown>;
}

export interface NewUser {
  email: string;
  password: string;
  company: string;
  variant: Variant;
  verified?: boolean;
}

export interface NewProject {
  userId: string;
  name: string;
  currency: string;
  variant: Variant;
}

// Demo-grade cost: fast enough for tests, still a real KDF.
const SCRYPT_OPTIONS = { N: 4096, r: 8, p: 1 };
const HASH_BYTES = 32;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Everything the demo app remembers. In memory, per process; POST /__reset clears it. */
export class Store {
  private readonly users = new Map<string, User>();
  private readonly projects = new Map<string, Project>();
  private readonly sessions = new Map<string, Session>();
  private readonly log: LoggedEvent[] = [];
  private eventSeq = 0;

  constructor(private readonly now: () => Date = () => new Date()) {
    this.seed();
  }

  reset(): void {
    this.users.clear();
    this.projects.clear();
    this.sessions.clear();
    this.log.length = 0;
    this.eventSeq = 0;
    this.seed();
  }

  // --- sessions ---------------------------------------------------------------

  createSession(): Session {
    const session: Session = {
      id: this.newId('ses', 16),
      createdAt: this.timestamp(),
      signupStarted: false,
      pendingClientEvents: [],
    };
    this.sessions.set(session.id, session);
    return session;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  // --- users ------------------------------------------------------------------

  createUser(input: NewUser): User {
    const email = normalizeEmail(input.email);
    if (this.findUserByEmail(email)) throw new Error(`user already exists: ${email}`);
    const user: User = {
      id: this.newId('usr'),
      email,
      passwordHash: hashPassword(input.password),
      company: input.company.trim(),
      createdAt: this.timestamp(),
      signupVariant: input.variant,
      verified: input.verified ?? false,
      bankSkipped: false,
      invites: [],
      inviteStepDone: false,
    };
    this.users.set(user.id, user);
    return user;
  }

  getUser(id: string): User | undefined {
    return this.users.get(id);
  }

  findUserByEmail(email: string): User | undefined {
    const wanted = normalizeEmail(email);
    for (const user of this.users.values()) if (user.email === wanted) return user;
    return undefined;
  }

  verifyPassword(user: User, password: string): boolean {
    return checkPassword(user.passwordHash, password);
  }

  deleteUser(id: string): void {
    this.users.delete(id);
    for (const [projectId, project] of this.projects) {
      if (project.userId === id) this.projects.delete(projectId);
    }
    for (const session of this.sessions.values()) {
      if (session.userId === id) session.userId = undefined;
    }
  }

  // --- projects ---------------------------------------------------------------

  createProject(input: NewProject): Project {
    const project: Project = {
      id: this.newId('prj'),
      userId: input.userId,
      name: input.name.trim(),
      currency: input.currency,
      createdAt: this.timestamp(),
      variant: input.variant,
    };
    this.projects.set(project.id, project);
    return project;
  }

  getProject(id: string): Project | undefined {
    return this.projects.get(id);
  }

  projectsForUser(userId: string): Project[] {
    return [...this.projects.values()].filter((p) => p.userId === userId);
  }

  // --- events -----------------------------------------------------------------

  logEvent(event: string, distinctId: string, properties: Record<string, unknown>): LoggedEvent {
    const entry: LoggedEvent = {
      id: `evt_${String(++this.eventSeq).padStart(6, '0')}`,
      event,
      distinct_id: distinctId,
      timestamp: this.timestamp(),
      properties,
    };
    this.log.push(entry);
    return entry;
  }

  get events(): readonly LoggedEvent[] {
    return this.log;
  }

  // --- internals --------------------------------------------------------------

  private seed(): void {
    this.createUser({
      email: TAKEN_EMAIL,
      password: 'Taken-pass-1',
      company: 'Taken Industries',
      variant: 'control',
      verified: true,
    });
  }

  private newId(prefix: string, bytes = 8): string {
    return `${prefix}_${randomBytes(bytes).toString('hex')}`;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, HASH_BYTES, SCRYPT_OPTIONS).toString('hex');
  return `${salt}:${hash}`;
}

function checkPassword(stored: string, password: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, HASH_BYTES, SCRYPT_OPTIONS);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
