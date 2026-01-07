import { Account, SignerlessAccount } from '@aztec/aztec.js/account';
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { createLogger } from '@aztec/aztec.js/log';
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import {
  AccountManager,
  type DeployAccountOptions,
  type SimulateOptions,
} from '@aztec/aztec.js/wallet';
import { SPONSORED_FPC_SALT } from '@aztec/constants';
import {
  AccountFeePaymentMethodOptions,
  type DefaultAccountEntrypointOptions,
} from '@aztec/entrypoints/account';
import { randomBytes } from '@aztec/foundation/crypto/random';
import { Fr } from '@aztec/foundation/curves/bn254';
import { EcdsaRAccountContract } from '@aztec/accounts/ecdsa/lazy';
import { SchnorrAccountContract } from '@aztec/accounts/schnorr/lazy';

import { getPXEConfig } from '@aztec/pxe/config';
import { createPXE } from '@aztec/pxe/client/lazy';
import { getInitialTestAccountsData } from '@aztec/accounts/testing/lazy';
import {
  getStubAccountContractArtifact,
  createStubAccount,
} from '@aztec/accounts/stub/lazy';
import {
  ExecutionPayload,
  mergeExecutionPayloads,
  type TxSimulationResult,
} from '@aztec/stdlib/tx';
import { GasSettings } from '@aztec/stdlib/gas';
import { AztecAddress } from '@aztec/stdlib/aztec-address';
import { type FeeOptions, BaseWallet } from '@aztec/wallet-sdk/base-wallet';

const PROVER_ENABLED = false;

const logger = createLogger('wallet');
const LocalStorageKey = 'aztec-account';

// This is a minimal implementation of an Aztec wallet
// WARNING: This example code stores the wallet in plain text in LocalStorage. Do not use in production without understanding the security implications
export class EmbeddedWallet extends BaseWallet {
  connectedAccount: AztecAddress | null = null;
  protected accounts: Map<string, Account> = new Map();

  protected async getAccountFromAddress(
    address: AztecAddress
  ): Promise<Account> {
    let account: Account | undefined;
    if (address.equals(AztecAddress.ZERO)) {
      const chainInfo = await this.getChainInfo();
      account = new SignerlessAccount(chainInfo);
    } else {
      account = this.accounts.get(address?.toString() ?? '');
    }

    if (!account) {
      throw new Error(`Account not found in wallet for address: ${address}`);
    }

    return account;
  }

  /**
   * Returns default values for the transaction fee options
   * if they were omitted by the user.
   * This wallet will use the sponsoredFPC payment method
   * unless otherwise stated
   * @param from - The address where the transaction is being sent from
   * @param feePayer - The address paying for fees (if embedded in the execution payload)
   * @param gasSettings - User-provided partial gas settings
   * @returns - Populated fee options that can be used to create a transaction execution request
   */
  protected override async completeFeeOptions(
    from: AztecAddress,
    feePayer?: AztecAddress,
    gasSettings?: Partial<GasSettings>
  ): Promise<FeeOptions> {
    const maxFeesPerGas =
      gasSettings?.maxFeesPerGas ??
      (await this.aztecNode.getCurrentBaseFees()).mul(1 + this.baseFeePadding);
    let walletFeePaymentMethod;
    let accountFeePaymentMethodOptions;
    // The transaction does not include a fee payment method, so we set a default
    if (!feePayer) {
      const sponsoredFPCContract =
        await EmbeddedWallet.#getSponsoredPFCContract();
      walletFeePaymentMethod = new SponsoredFeePaymentMethod(
        sponsoredFPCContract.instance.address
      );
      accountFeePaymentMethodOptions = AccountFeePaymentMethodOptions.EXTERNAL;
    } else {
      // The transaction includes fee payment method, so we check if we are the fee payer for it
      // (this can only happen if the embedded payment method is FeeJuiceWithClaim)
      accountFeePaymentMethodOptions = from.equals(feePayer)
        ? AccountFeePaymentMethodOptions.FEE_JUICE_WITH_CLAIM
        : AccountFeePaymentMethodOptions.EXTERNAL;
    }
    const fullGasSettings: GasSettings = GasSettings.default({
      ...gasSettings,
      maxFeesPerGas,
    });
    this.log.debug(`Using L2 gas settings`, fullGasSettings);
    return {
      gasSettings: fullGasSettings,
      walletFeePaymentMethod,
      accountFeePaymentMethodOptions,
    };
  }

  getAccounts() {
    return Promise.resolve(
      Array.from(this.accounts.values()).map((acc) => ({
        alias: '',
        item: acc.getAddress(),
      }))
    );
  }

  static async initialize(nodeUrl: string) {
    // Create Aztec Node Client
    const aztecNode = createAztecNodeClient(nodeUrl);

    // Create PXE
    const config = getPXEConfig();
    config.l1Contracts = await aztecNode.getL1ContractAddresses();
    config.proverEnabled = PROVER_ENABLED;
    const pxe = await createPXE(aztecNode, config, {
      useLogSuffix: true,
    });

    // Register Sponsored FPC Contract with PXE
    await pxe.registerContract(await EmbeddedWallet.#getSponsoredPFCContract());

    // Log the Node Info
    const nodeInfo = await aztecNode.getNodeInfo();
    logger.info('PXE Connected to node', nodeInfo);
    return new EmbeddedWallet(pxe, aztecNode);
  }

  // Internal method to use the Sponsored FPC Contract for fee payment
  static async #getSponsoredPFCContract() {
    const { SponsoredFPCContractArtifact } = await import(
      '@aztec/noir-contracts.js/SponsoredFPC'
    );
    const instance = await getContractInstanceFromInstantiationParams(
      SponsoredFPCContractArtifact,
      {
        salt: new Fr(SPONSORED_FPC_SALT),
      }
    );

    return {
      instance,
      artifact: SponsoredFPCContractArtifact,
    };
  }

  getConnectedAccount() {
    if (!this.connectedAccount) {
      return null;
    }
    return this.connectedAccount;
  }

  private async registerAccount(accountManager: AccountManager) {
    const instance = await accountManager.getInstance();
    const artifact = await accountManager
      .getAccountContract()
      .getContractArtifact();

    await this.registerContract(
      instance,
      artifact,
      accountManager.getSecretKey()
    );
  }

  async connectTestAccount(index: number) {
    const testAccounts = await getInitialTestAccountsData();
    const accountData = testAccounts[index];

    const accountManager = await AccountManager.create(
      this,
      accountData.secret,
      new SchnorrAccountContract(accountData.signingKey),
      accountData.salt
    );

    await this.registerAccount(accountManager);
    this.accounts.set(
      accountManager.address.toString(),
      await accountManager.getAccount()
    );

    this.connectedAccount = accountManager.address;
    return this.connectedAccount;
  }

  // Create a new account
  async createAccountAndConnect() {
    if (!this.pxe) {
      throw new Error('PXE not initialized');
    }

    // Generate a random salt, secret key, and signing key
    const salt = Fr.random();
    const secretKey = Fr.random();
    const signingKey = randomBytes(32);

    // Create an ECDSA account
    const contract = new EcdsaRAccountContract(signingKey);
    const accountManager = await AccountManager.create(
      this,
      secretKey,
      contract,
      salt
    );

    // Register the account with PXE BEFORE deploying
    // This is needed because the deployment process requires the account to exist in the wallet
    await this.registerAccount(accountManager);
    this.accounts.set(
      accountManager.address.toString(),
      await accountManager.getAccount()
    );

    // Deploy the account
    const deployMethod = await accountManager.getDeployMethod();
    const sponsoredPFCContract =
      await EmbeddedWallet.#getSponsoredPFCContract();
    const deployOpts: DeployAccountOptions = {
      from: AztecAddress.ZERO,
      fee: {
        paymentMethod: new SponsoredFeePaymentMethod(
          sponsoredPFCContract.instance.address
        ),
      },
      skipClassPublication: true,
      skipInstancePublication: true,
    };

    const receipt = await deployMethod.send(deployOpts).wait({ timeout: 120 });

    logger.info('Account deployed', receipt);

    // Store the account in local storage
    localStorage.setItem(
      LocalStorageKey,
      JSON.stringify({
        address: accountManager.address.toString(),
        signingKey: signingKey.toString('hex'),
        secretKey: secretKey.toString(),
        salt: salt.toString(),
      })
    );

    this.connectedAccount = accountManager.address;
    return this.connectedAccount;
  }

  async connectExistingAccount() {
    // Read key from local storage and create the account
    const account = localStorage.getItem(LocalStorageKey);
    if (!account) {
      return null;
    }
    const parsed = JSON.parse(account);

    const contract = new EcdsaRAccountContract(
      Buffer.from(parsed.signingKey, 'hex')
    );
    const accountManager = await AccountManager.create(
      this,
      Fr.fromString(parsed.secretKey),
      contract,
      Fr.fromString(parsed.salt)
    );

    await this.registerAccount(accountManager);
    this.accounts.set(
      accountManager.address.toString(),
      await accountManager.getAccount()
    );
    this.connectedAccount = accountManager.address;
    return this.connectedAccount;
  }

  private async getFakeAccountDataFor(address: AztecAddress) {
    const chainInfo = await this.getChainInfo();
    const originalAccount = await this.getAccountFromAddress(address);
    const originalAddress = await originalAccount.getCompleteAddress();
    const { contractInstance } = await this.pxe.getContractMetadata(
      originalAddress.address
    );
    if (!contractInstance) {
      throw new Error(
        `No contract instance found for address: ${originalAddress.address}`
      );
    }
    const stubAccount = createStubAccount(originalAddress, chainInfo);
    const StubAccountContractArtifact = await getStubAccountContractArtifact();
    const instance = await getContractInstanceFromInstantiationParams(
      StubAccountContractArtifact,
      { salt: Fr.random() }
    );
    return {
      account: stubAccount,
      instance,
      artifact: StubAccountContractArtifact,
    };
  }

  async simulateTx(
    executionPayload: ExecutionPayload,
    opts: SimulateOptions
  ): Promise<TxSimulationResult> {
    const feeOptions = opts.fee?.estimateGas
      ? await this.completeFeeOptionsForEstimation(
          opts.from,
          executionPayload.feePayer,
          opts.fee?.gasSettings
        )
      : await this.completeFeeOptions(
          opts.from,
          executionPayload.feePayer,
          opts.fee?.gasSettings
        );
    const feeExecutionPayload =
      await feeOptions.walletFeePaymentMethod?.getExecutionPayload();
    const executionOptions: DefaultAccountEntrypointOptions = {
      txNonce: Fr.random(),
      cancellable: this.cancellableTransactions,
      feePaymentMethodOptions: feeOptions.accountFeePaymentMethodOptions,
    };
    const finalExecutionPayload = feeExecutionPayload
      ? mergeExecutionPayloads([feeExecutionPayload, executionPayload])
      : executionPayload;
    const {
      account: fromAccount,
      instance,
      artifact,
    } = await this.getFakeAccountDataFor(opts.from);
    const txRequest = await fromAccount.createTxExecutionRequest(
      finalExecutionPayload,
      feeOptions.gasSettings,
      executionOptions
    );
    const contractOverrides = {
      [opts.from.toString()]: { instance, artifact },
    };
    return this.pxe.simulateTx(
      txRequest,
      true /* simulatePublic */,
      true,
      true,
      {
        contracts: contractOverrides,
      }
    );
  }
}
