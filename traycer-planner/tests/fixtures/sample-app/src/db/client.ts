export interface UserRecord {
    id: string;
    name: string;
    email: string;
    createdAt: Date;
}

export const db = {
    nextId: 1,
    users: new Map<string, UserRecord>(),
};

export function resetDb(): void {
    db.nextId = 1;
    db.users.clear();
}
