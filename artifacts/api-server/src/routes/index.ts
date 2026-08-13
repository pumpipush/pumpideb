import { Router, type IRouter } from "express";
import healthRouter from "./health";
import tokensRouter from "./tokens";
import tradesRouter from "./trades";
import statsRouter from "./stats";
import profilesRouter from "./profiles";
import feedRouter from "./feed";
import proxyRouter from "./proxy";
import storageRouter from "./storage";
import walletRouter from "./wallet";
import authRouter from "./auth";
import blockhashRouter from "./blockhash";
import depositsRouter from "./deposits";
import creatorFeesRouter from "./creator-fees";

const router: IRouter = Router();

router.use(healthRouter);
router.use(blockhashRouter);
router.use(feedRouter);
router.use(tokensRouter);
router.use(tradesRouter);
router.use(statsRouter);
router.use(profilesRouter);
router.use(proxyRouter);
router.use(storageRouter);
router.use(walletRouter);
router.use(authRouter);
router.use(depositsRouter);
router.use(creatorFeesRouter);

export default router;
