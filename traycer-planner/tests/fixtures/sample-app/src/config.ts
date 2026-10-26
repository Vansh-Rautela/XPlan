export interface AppConfig {
    port: number;
}

export function loadConfig(): AppConfig {
    return { port: 3000 };
}
