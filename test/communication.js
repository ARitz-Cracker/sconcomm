const stream = require("stream");
const sconcomm = require('../index.js');
const chai = require('chai');
chai.use(require("chai-as-promised"));

const expect = chai.expect;
const shallowCopy = {copy:true};

class StreamCombiner extends stream.Writable {
    constructor(options) {
        super(options);
        this.chunkArrays = [];
        this.totalLength = 0;
        this.resultValue = new Promise((resolve, reject)=>{
            this._resolve = resolve;
            this._reject = reject;
        });
    }
    _destroy(err, callback){
        this._reject(err);
        callback(err);
    }
    _write(chunk, encoding, callback) {
        this.chunkArrays.push(chunk);
        this.totalLength += chunk.length;
        callback();
    }
    _final(callback) {
        this._resolve(Buffer.concat(this.chunkArrays, this.totalLength));
        callback(null);
    }
};
describe("Simple communication", function(){
    it("has a call/response structure", function(done){
        (async function() {
            try{
                const clientToServer = new stream.PassThrough();
                const serverToClient = new stream.PassThrough();
                const server = new sconcomm.Server(clientToServer, serverToClient);
                const client = new sconcomm.Client(serverToClient, clientToServer);
                
                const sendObject = {hello:"world!"};
                const responseObject = {how:"are you?"};
                responsePromise = client.send(sendObject, shallowCopy);
                await new Promise(function(resolve, reject) {
                    server.on("message", function(data, response){
                        try{
                            expect(data).to.deep.equal(sendObject);
                            response(responseObject, shallowCopy);
                            resolve(data);
                        }catch(ex){
                            reject(ex);
                        }
                    });
                });
                await expect(responsePromise).to.eventually.deep.equal(responseObject);
                done();
            }catch(ex){
                done(ex);
            }
        })();
    });
    it("can have the server push data to the client", function(done){
        (async function() {
            try{
                const clientToServer = new stream.PassThrough();
                const serverToClient = new stream.PassThrough();
                const server = new sconcomm.Server(clientToServer, serverToClient);
                const client = new sconcomm.Client(serverToClient, clientToServer);
                
                const responseObject = {how:"are you?"};
                responsePromise = new Promise(function(resolve, reject){
                    client.on("message", function(pushedData){
                        resolve(pushedData);
                    });
                    client.on("error", function(err){
                        reject(err);
                    });
                });
                await server.send(responseObject, shallowCopy);
                await expect(responsePromise).to.eventually.deep.equal(responseObject);
                done();
            }catch(ex){
                done(ex);
            }
        })();
    });
    it("terminates communications properly", function(done){
        (async function() {
            try{
                // Server initiates disconnect
                let clientToServer = new stream.PassThrough();
                let serverToClient = new stream.PassThrough();
                let server = new sconcomm.Server(clientToServer, serverToClient);
                let client = new sconcomm.Client(serverToClient, clientToServer);
                
                await Promise.all([
                    new Promise(function(resolve, reject) {
                        client.once("disconnected", resolve);
                    }),
                    server.disconnect()
                ]);

                // Client initiates disconnect
                clientToServer = new stream.PassThrough();
                serverToClient = new stream.PassThrough();
                server = new sconcomm.Server(clientToServer, serverToClient);
                client = new sconcomm.Client(serverToClient, clientToServer);
                
                await Promise.all([
                    new Promise(function(resolve, reject) {
                        server.once("disconnected", resolve);
                    }),
                    client.disconnect()
                ]);
                done();
            }catch(ex){
                done(ex);
            }
        })();
    });
    
    it("can send arbetrary streamed data", function(done){
        (async function() {
            try{
                const testStreamData = Buffer.from("This is some cool data");
                const testStream = new stream.PassThrough();
                const clientToServer = new stream.PassThrough();
                const serverToClient = new stream.PassThrough();
                const server = new sconcomm.Server(clientToServer, serverToClient);
                const client = new sconcomm.Client(serverToClient, clientToServer);
                
                const sendObject = {hello:"world!"};
                const responseObject = {how:"are you?"};
                responsePromise = client.send(sendObject, shallowCopy, testStream, testStreamData.length);
                testStream.write(testStreamData);
                testStream.end();
                await new Promise(function(resolve, reject) {
                    server.on("message", async function(data, response){
                        try{
							expect(data).to.haveOwnProperty("_stream");
							const c = new StreamCombiner();
							data._stream.pipe(c);
							await expect(c.resultValue).to.eventually.deep.equal(testStreamData);
							response(responseObject, shallowCopy);
                            resolve(data);
                        }catch(ex){
                            reject(ex);
                        }
                    });
				});
				await expect(responsePromise).to.eventually.deep.equal(responseObject);
                done();
            }catch(ex){
                done(ex);
            }
        })();
    });
    
});