import nacl from 'tweetnacl';
import { Buffer } from 'buffer';

const senderKeys = nacl.box.keyPair();
const recipientKeys = nacl.box.keyPair();

console.log('Sender Public Key:', Buffer.from(senderKeys.publicKey).toString('base64'));
console.log('Sender Private Key:', Buffer.from(senderKeys.secretKey).toString('base64'));
console.log('Recipient Public Key:', Buffer.from(recipientKeys.publicKey).toString('base64'));
console.log('Recipient Private Key:', Buffer.from(recipientKeys.secretKey).toString('base64'));