import { take, put, call, fork, select, takeEvery, all, cancel } from 'redux-saga/effects'
import { delay } from 'redux-saga';
import * as actions from '../actions/transferActions'
import * as utilActions from '../actions/utilActions'
import constants from "../services/constants"
import * as converter from "../utils/converter"
import * as commonUtils from "../utils/common"
import * as ethUtil from 'ethereumjs-util'

import * as common from "./common"

import Tx from "../services/tx"
import { updateAccount, incManualNonceAccount } from '../actions/accountActions'
import { addTx } from '../actions/txActions'
import { store } from "../store"

function* broadCastTx(action) {
  const { ethereum, tx, account, data } = action.payload
  try {
    yield put(actions.prePareBroadcast())
    const hash = yield call([ethereum, ethereum.callMultiNode], "sendRawTransaction", tx)
    yield call(runAfterBroadcastTx, ethereum, tx, hash, account, data)
  }
  catch (e) {
    console.log(e)
    yield call(doTransactionFail, ethereum, account, e.message)
  }
}

export function* runAfterBroadcastTx(ethereum, txRaw, hash, account, data) {
  const tx = new Tx(
    hash, account.address, ethUtil.bufferToInt(txRaw.gas),
    converter.weiToGwei(ethUtil.bufferToInt(txRaw.gasPrice)),
    ethUtil.bufferToInt(txRaw.nonce), "pending", "transfer", data)
  yield put(incManualNonceAccount(account.address))
  yield put(updateAccount(ethereum, account))
  yield put(addTx(tx))
  yield put(actions.doTransactionComplete(hash))
  yield put(actions.finishTransfer())

  //estimate time for tx
  var state = store.getState()
  var gasInfo = state.exchange.gasPriceSuggest
  var gasPrice = state.exchange.gasPrice
  var estimateTime = commonUtils.estimateTimeTx({ ...gasInfo, gasPrice })

  var estimateTimeSecond = estimateTime * 60000

  store.dispatch(actions.setEstimateTimeProgress(estimateTimeSecond))

  var watchProgress = yield fork(watchProgressFunc, estimateTimeSecond)

  yield take('GLOBAL.CLEAR_SESSION')
  yield cancel(watchProgress)
}

export function* watchProgressFunc(estimateTime) {
  var step = Math.round(estimateTime / 100)
  var stepProgress = Math.max(3000, step)
  console.log(stepProgress)
  var runner = 0
  while (true) {
    console.log("Progress_running_transfer")
    if (runner > estimateTime) {
      store.dispatch(actions.showInfoProgress())
      return
    }
    //check tx is mined
    var state = store.getState()
    var hash = state.transfer.txHash
    var txs = state.txs
    if (txs[hash] && txs[hash].status !== "pending") {
      return
    }

    store.dispatch(actions.setCurrentTimeProgress(runner))
    runner += stepProgress
    yield call(delay, stepProgress)
  }
}

function* doTransactionFail(ethereum, account, e) {
  yield put(actions.doTransactionFail(e))
  //yield put(incManualNonceAccount(account.address))
  yield put(updateAccount(ethereum, account))
}

function* doTxFail(ethereum, account, e) {
  yield put(actions.setBroadcastError(e))
  yield put(updateAccount(ethereum, account))
}

export function* processTransfer(action) {
  const { formId, ethereum, address,
    token, amount,
    destAddress, nonce, gas,
    gasPrice, keystring, type, password, account, data, keyService, balanceData } = action.payload
  var callService = token == constants.ETHER_ADDRESS ? "sendEtherFromAccount" : "sendTokenFromAccount"
  switch (type) {
    case "keystore":
      yield call(transferKeystore, action, callService)
      break
    case "privateKey":
    case "trezor":
    case "ledger":
      yield call(transferColdWallet, action, callService)
      break
    case "metamask":
      yield call(transferMetamask, action, callService)
      break
  }
}

function* transferKeystore(action, callService) {
  const { formId, ethereum, address,
    token, amount,
    destAddress, nonce, gas,
    gasPrice, keystring, type, password, account, data, keyService, balanceData } = action.payload
  try {
    var rawTx = yield call(keyService.callSignTransaction, callService, formId, ethereum, address,
      token, amount,
      destAddress, nonce, gas,
      gasPrice, keystring, type, password)
  } catch (e) {
    yield put(actions.throwPassphraseError(e.message))
    return
  }
  try {
    yield put(actions.prePareBroadcast(balanceData))
    const hash = yield call([ethereum, ethereum.callMultiNode], "sendRawTransaction", rawTx)
    yield call(runAfterBroadcastTx, ethereum, rawTx, hash, account, data)
  } catch (e) {
    yield call(doTxFail, ethereum, account, e.message)
  }

}

function* transferColdWallet(action, callService) {
  const { formId, ethereum, address,
    token, amount,
    destAddress, nonce, gas,
    gasPrice, keystring, type, password, account, data, keyService, balanceData } = action.payload
  try {
    var rawTx
    try {
      rawTx = yield call(keyService.callSignTransaction, callService, formId, ethereum, address,
        token, amount,
        destAddress, nonce, gas,
        gasPrice, keystring, type, password)
    } catch (e) {
      let msg = ''
      if (e.native && type == 'ledger') {
        msg = keyService.getLedgerError(e.native)
      }
      yield put(actions.setSignError(msg))
      return
    }

    yield put(actions.prePareBroadcast(balanceData))
    const hash = yield call([ethereum, ethereum.callMultiNode], "sendRawTransaction", rawTx)
    yield call(runAfterBroadcastTx, ethereum, rawTx, hash, account, data)
  } catch (e) {
    let msg = ''
    if (type == 'ledger') {
      msg = keyService.getLedgerError(e.native)
    } else {
      msg = e.message
    }
    yield call(doTxFail, ethereum, account, msg)
    return
  }
}

function* transferMetamask(action, callService) {
  const { formId, ethereum, address,
    token, amount,
    destAddress, nonce, gas,
    gasPrice, keystring, type, password, account, data, keyService, balanceData } = action.payload
  try {
    var hash
    try {
      hash = yield call(keyService.callSignTransaction, callService, formId, ethereum, address,
        token, amount,
        destAddress, nonce, gas,
        gasPrice, keystring, type, password)
    } catch (e) {
      console.log(e)
      yield put(actions.setSignError(e))
      return
    }

    yield put(actions.prePareBroadcast(balanceData))
    const rawTx = { gas, gasPrice, nonce }
    yield call(runAfterBroadcastTx, ethereum, rawTx, hash, account, data)
  } catch (e) {
    console.log(e)
    let msg = converter.sliceErrorMsg(e.message)
    yield call(doTxFail, ethereum, account, msg)
    return
  }
}

function* estimateGasUsed(action) {
  var state = store.getState()
  var transfer = state.transfer

  var tokens = state.tokens.tokens
  var decimal = 18
  var tokenSymbol = state.transfer.tokenSymbol
  if (tokens[tokenSymbol]) {
    decimal = tokens[tokenSymbol].decimal
  }

  var account = state.account.account
  var fromAddr = account.address

  var gasRequest = yield call(common.handleRequest, calculateGasUse, fromAddr, transfer.tokenSymbol, transfer.token, decimal, transfer.amount)
  if (gasRequest.status === "success"){
    const gas = gasRequest.data
    yield put(actions.setGasUsed(gas))
  }
  if ((gasRequest.status === "timeout") || (gasRequest.status === "fail")){
    var state = store.getState()
    var transfer = state.transfer
    var gasLimit = transfer.gas_limit
    yield put(actions.setGasUsed(gasLimit))
  }
//  yield call(calculateGasUse, fromAddr, transfer.tokenSymbol, transfer.token, decimal, transfer.amount)
}



function* estimateGasUsedWhenSelectToken(action) {
  const { symbol, address } = action.payload

  var state = store.getState()
  var transfer = state.transfer

  var tokens = state.tokens.tokens
  var decimal = 18
  var tokenSymbol = symbol
  if (tokens[tokenSymbol]) {
    decimal = tokens[tokenSymbol].decimal
  }

  var account = state.account.account
  var fromAddr = account.address

  var gasRequest = yield call(common.handleRequest, calculateGasUse, fromAddr, tokenSymbol, address, decimal, transfer.amount)
  if (gasRequest.status === "success"){
    const gas = gasRequest.data
    yield put(actions.setGasUsed(gas))
  }
  if ((gasRequest.status === "timeout") || (gasRequest.status === "fail")){
    var state = store.getState()
    var transfer = state.transfer
    var gasLimit = transfer.gas_limit
    yield put(actions.setGasUsed(gasLimit))
  }

  //yield call(calculateGasUse, fromAddr, tokenSymbol, address, decimal, transfer.amount)
}

function* estimateGasUsedWhenChangeAmount(action) {
  var amount = action.payload

  var state = store.getState()
  var transfer = state.transfer
  var tokens = state.tokens.tokens

  var decimal = 18
  var tokenSymbol = transfer.tokenSymbol
  if (tokens[tokenSymbol]) {
    decimal = tokens[tokenSymbol].decimal
  }

  var account = state.account.account
  var fromAddr = account.address

  var gasRequest = yield call(common.handleRequest, calculateGasUse, fromAddr, tokenSymbol, transfer.token, decimal, amount)
  if (gasRequest.status === "success"){
    const gas = gasRequest.data
    yield put(actions.setGasUsed(gas))
  }
  if ((gasRequest.status === "timeout") || (gasRequest.status === "fail")){
    var state = store.getState()
    var transfer = state.transfer
    var gasLimit = transfer.gas_limit
    yield put(actions.setGasUsed(gasLimit))
  }

 // yield call(calculateGasUse, fromAddr, tokenSymbol, transfer.token, decimal, amount)
}


function* fetchGas() {
  var state = store.getState()
  var transfer = state.transfer
  var tokens = state.tokens.tokens

  var decimal = 18
  var tokenSymbol = transfer.tokenSymbol
  if (tokens[tokenSymbol]) {
    decimal = tokens[tokenSymbol].decimal
  }

  var account = state.account.account
  var fromAddr = account.address



  var gasRequest = yield call(common.handleRequest, calculateGasUse, fromAddr, tokenSymbol, transfer.token, decimal, transfer.amount)
  if (gasRequest.status === "success"){
    const gas = gasRequest.data
    yield put(actions.setGasUsed(gas))
  }
  if ((gasRequest.status === "timeout") || (gasRequest.status === "fail")){
    var state = store.getState()
    var transfer = state.transfer
    var gasLimit = transfer.gas_limit
    yield put(actions.setGasUsed(gasLimit))
  }

  //yield call(calculateGasUse, fromAddr, tokenSymbol, transfer.token, decimal, transfer.amount)
  yield put(actions.fetchGasSuccess())
}

function* calculateGasUse(fromAddr, tokenSymbol, tokenAddr, tokenDecimal, sourceAmount){
    var state = store.getState()
    var ethereum = state.connection.ethereum
    var transfer = state.transfer
    const amount = converter.stringToHex(sourceAmount, tokenDecimal)
    var gasLimit = transfer.gas_limit
    var gas = 0
    var internalAdrr = "0x3cf628d49ae46b49b210f0521fbd9f82b461a9e1"
    var txObj
    if (tokenSymbol === 'ETH'){
      var destAddr = transfer.destAddress !== "" ? transfer.destAddress : internalAdrr
      txObj = {
        from : fromAddr,
        value: amount,
        to:destAddr
      }
      try{
        gas = yield call([ethereum, ethereum.call],"estimateGas", txObj)
        if(gas > 21000){
          gas = Math.round(gas * 120 / 100)
        }
        return {status: "success", res: gas}
      //  yield put(actions.setGasUsed(gas))
      }catch(e){
        console.log(e.message)
        return {"status": "success", res: gasLimit}
        //yield put(actions.setGasUsed(gasLimit))
      }
    }else{
      try{
        var destAddr = transfer.destAddress !== "" ? transfer.destAddress : internalAdrr
        var data = yield call([ethereum, ethereum.call],"sendTokenData", tokenAddr, amount, destAddr)
        txObj = {
          from : fromAddr,
          value:"0",
          to:tokenAddr,
          data: data
        }
        gas = yield call([ethereum, ethereum.call],"estimateGas", txObj)
        gas = Math.round(gas * 120 / 100)
        return {"status": "success", res: gas}
        //return gas
      //  yield put(actions.setGasUsed(gas))
      }catch(e){
        console.log(e.message)
        return {"status": "success", res: gasLimit}
        //return gasLimit
        //yield put(actions.setGasUsed(gasLimit))
      }
      gas = yield call([ethereum, ethereum.call], "estimateGas", txObj)
      gas = Math.round(gas * 120 / 100)
      yield put(actions.setGasUsed(gas))
    }
  //    catch (e) {
  //     console.log(e.message)
  //     yield put(actions.setGasUsed(gasLimit))
  //   }
  // }
}

export function* watchTransfer() {
  yield takeEvery("TRANSFER.TX_BROADCAST_PENDING", broadCastTx)
  yield takeEvery("TRANSFER.PROCESS_TRANSFER", processTransfer)

  yield takeEvery("TRANSFER.ESTIMATE_GAS_USED", estimateGasUsed)
  yield takeEvery("TRANSFER.SELECT_TOKEN", estimateGasUsedWhenSelectToken)
  yield takeEvery("TRANSFER.TRANSFER_SPECIFY_AMOUNT", estimateGasUsedWhenChangeAmount)
  yield takeEvery("TRANSFER.FETCH_GAS", fetchGas)
}