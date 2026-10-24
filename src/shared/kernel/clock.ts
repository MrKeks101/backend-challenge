/** Fonte de tempo injetável. O domínio nunca chama `new Date()` diretamente, para ser determinístico em teste. */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
