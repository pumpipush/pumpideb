import { Router, type IRouter } from "express";
import healthRouter from "./health";
import tokensRouter from "./tokens";
import tradesRouter from "./trades";
import statsRouter from "./stats";
import profilesRouter from "./profiles";
import feedRouter from "./feed";

const router: IRouter = Router();

router.use(healthRouter);
router.use(feedRouter);
router.use(tokensRouter);
router.use(tradesRouter);
router.use(statsRouter);
router.use(profilesRouter);

export default router;
