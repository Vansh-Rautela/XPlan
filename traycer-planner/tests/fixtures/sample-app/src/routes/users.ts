import { Router } from 'express';
import { createUser, deleteUser, listUsers } from '../services/userService.js';
import { isNonEmptyString } from '../utils/validation.js';

export const usersRouter = Router();

usersRouter.get('/', (_req, res) => {
    res.json(listUsers());
});

usersRouter.post('/', (req, res) => {
    const { name, email } = req.body ?? {};
    if (!isNonEmptyString(name) || !isNonEmptyString(email)) {
        res.status(400).json({ error: 'name and email are required' });
        return;
    }
    res.status(201).json(createUser(name, email));
});

usersRouter.delete('/:id', (req, res) => {
    const removed = deleteUser(req.params.id);
    res.status(removed ? 204 : 404).end();
});
