import { Router } from 'express';
import type { AuthService } from './auth.service';
import { parseLoginRequest, parseRegisterRequest } from './auth.validation';

export function createAuthRouter(auth: AuthService): Router {
  const router = Router();

  router.post('/register', async (req, res) => {
    const result = await auth.register(parseRegisterRequest(req.body));
    res.status(201).json(result);
  });

  router.post('/login', async (req, res) => {
    const result = await auth.login(parseLoginRequest(req.body));
    res.status(200).json(result);
  });

  return router;
}
