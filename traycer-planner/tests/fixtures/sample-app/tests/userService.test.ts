import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb } from '../src/db/client.js';
import { createUser, deleteUser, listUsers } from '../src/services/userService.js';

test('creates and lists users', () => {
    resetDb();
    createUser('Ada', 'ada@example.com');
    assert.equal(listUsers().length, 1);
});

test('deletes users', () => {
    resetDb();
    const user = createUser('Ada', 'ada@example.com');
    assert.equal(deleteUser(user.id), true);
    assert.equal(listUsers().length, 0);
});
