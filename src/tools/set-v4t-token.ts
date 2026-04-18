import { persistVibe4TradingToken } from "../v4t";

export async function set_v4t_token(args: { token: string | null }) {
  const state = await persistVibe4TradingToken(args.token);
  return {
    persisted: true,
    hasToken: state.vibe4tradingToken !== null,
  };
}
