import { db, type UserRecord } from '../db/client.js';

export function listUsers(): UserRecord[] {
    return [...db.users.values()];
}

export function findUserByEmail(email: string): UserRecord | undefined {
    return listUsers().find(u => u.email === email);
}

export function createUser(name: string, email: string): UserRecord {
    const user: UserRecord = { id: String(db.nextId++), name, email, createdAt: new Date() };
    db.users.set(user.id, user);
    return user;
}

export function deleteUser(id: string): boolean {
    return db.users.delete(id);
}
