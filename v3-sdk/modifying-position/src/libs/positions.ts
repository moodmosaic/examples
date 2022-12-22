import { ethers } from 'ethers'
import {
  ERC20_ABI,
  NONFUNGIBLE_POSITION_MANAGER_ABI,
  MAX_FEE_PER_GAS,
  MAX_PRIORITY_FEE_PER_GAS,
  NONFUNGIBLE_POSITION_MANAGER_CONTRACT_ADDRESS,
} from './constants'
import { TOKEN_AMOUNT_TO_APPROVE_FOR_TRANSFER } from './constants'
import { sendTransaction, TransactionState } from './providers'
import {
  Pool,
  Position,
  nearestUsableTick,
  MintOptions,
  NonfungiblePositionManager,
} from '@uniswap/v3-sdk'
import { fromReadableAmount } from '../libs/conversion'
import { CurrentConfig } from '../config'
import { getPoolInfo } from './pool'
import { getProvider, getWalletAddress } from '../libs/providers'
import { Percent } from '@uniswap/sdk-core'

export async function getPositionIds(
  provider: ethers.providers.Provider,
  address: string,
  contractAddress: string
): Promise<number[]> {
  // Get currency otherwise
  const positionContract = new ethers.Contract(
    contractAddress,
    NONFUNGIBLE_POSITION_MANAGER_ABI,
    provider
  )
  // Get number of positions
  const balance: number = await positionContract.balanceOf(address)

  // Get all positions
  const tokenIds = []
  for (let i = 0; i < balance; i++) {
    const tokenOfOwnerByIndex: number =
      await positionContract.tokenOfOwnerByIndex(address, i)
    tokenIds.push(tokenOfOwnerByIndex)
  }

  return tokenIds
}

export async function getTokenTransferApprovals(
  provider: ethers.providers.Provider,
  tokenAddress: string,
  fromAddress: string,
  toAddress: string
): Promise<TransactionState> {
  if (!provider) {
    console.log('No Provider Found')
    return TransactionState.Failed
  }

  try {
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider)

    const transaction = await tokenContract.populateTransaction.approve(
      toAddress,
      TOKEN_AMOUNT_TO_APPROVE_FOR_TRANSFER
    )

    await sendTransaction({
      ...transaction,
      from: fromAddress,
    })
  } catch (e) {
    console.error(e)
    return TransactionState.Failed
  }

  return TransactionState.Sent
}

export const getPosition = async (
  percentageToIncrease?: number
): Promise<Position> => {
  // get pool info
  const poolInfo = await getPoolInfo()

  // construct pool instance
  const USDC_DAI_POOL = new Pool(
    CurrentConfig.tokens.token0,
    CurrentConfig.tokens.token1,
    poolInfo.fee,
    poolInfo.sqrtPriceX96.toString(),
    poolInfo.liquidity.toString(),
    poolInfo.tick
  )

  let amount0 = fromReadableAmount(
    CurrentConfig.tokens.token0Amount,
    CurrentConfig.tokens.token0.decimals
  )
  let amount1 = fromReadableAmount(
    CurrentConfig.tokens.token1Amount,
    CurrentConfig.tokens.token1.decimals
  )

  if (percentageToIncrease) {
    amount0 = (amount0 * percentageToIncrease) / 100
    amount1 = (amount1 * percentageToIncrease) / 100
  }

  // create position using the maximum liquidity from input amounts
  return Position.fromAmounts({
    pool: USDC_DAI_POOL,
    tickLower:
      nearestUsableTick(poolInfo.tick, poolInfo.tickSpacing) -
      poolInfo.tickSpacing * 2,
    tickUpper:
      nearestUsableTick(poolInfo.tick, poolInfo.tickSpacing) +
      poolInfo.tickSpacing * 2,
    amount0,
    amount1,
    useFullPrecision: true,
  })
}

export async function mintPosition(): Promise<TransactionState> {
  const address = getWalletAddress()
  const provider = getProvider()
  if (!address || !provider) {
    return TransactionState.Failed
  }
  // Give approval to the contract to transfer tokens
  const tokenInApproval = await getTokenTransferApprovals(
    provider,
    CurrentConfig.tokens.token0.address,
    address,
    NONFUNGIBLE_POSITION_MANAGER_CONTRACT_ADDRESS
  )
  const tokenOutApproval = await getTokenTransferApprovals(
    provider,
    CurrentConfig.tokens.token1.address,
    address,
    NONFUNGIBLE_POSITION_MANAGER_CONTRACT_ADDRESS
  )

  if (
    tokenInApproval !== TransactionState.Sent ||
    tokenOutApproval !== TransactionState.Sent
  ) {
    return TransactionState.Failed
  }

  const minPositionOptions: MintOptions = {
    recipient: address,
    deadline: Math.floor(Date.now() / 1000) + 60 * 20,
    slippageTolerance: new Percent(50, 10_000),
  }

  // get calldata for minting a position
  const { calldata, value } = NonfungiblePositionManager.addCallParameters(
    await getPosition(),
    minPositionOptions
  )

  // build transaction
  const transaction = {
    data: calldata,
    to: NONFUNGIBLE_POSITION_MANAGER_CONTRACT_ADDRESS,
    value: value,
    from: address,
    maxFeePerGas: MAX_FEE_PER_GAS,
    maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS,
  }

  await sendTransaction(transaction)
  return TransactionState.Sent
}