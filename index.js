const EventEmitter = require('events');
const { PassThrough, Duplex, Writable } = require('stream');
const scon = require("scon");

const shallowCopy = function(obj){
	let newObj = {};
	for(let i in obj) {
		newObj[i] = obj[i];
	}
	return newObj;
}

class SCONCommError extends Error {
	constructor(message) {
		super(message);
	}
}
let writeAndWait = function(stream,data){
	return new Promise(function(resolve, reject){
		if (stream.write(data)){
			resolve();
		}else{
			let errFunc = function(err){
				reject(err);
			}
			stream.once("error",errFunc);
			stream.once("drain",function(){
				stream.removeListener('error', errFunc);
				resolve();
			});
			
		}
	});
}

class FixedLengthStream extends Duplex{
	constructor(len) {
		super();
		this.totalLength = len|0;
        this._currentLength = 0;
        this.leftover = new Promise((resolve, reject)=>{
            this._resolve = resolve;
            this._reject = reject;
        });
	}
	_read(size){
		
		//push requested
		if (this.callback){
			this.callback();
		}
	}
	_write(chunk,encoding,callback){
		if (this.finished){
			callback();
			return;
		}
		if (chunk.length + this._currentLength > this.totalLength){
            const endMark = this.totalLength - this._currentLength;
			this.push(chunk.slice(0,endMark));
			this.finished = true;
            this._resolve(chunk.slice(endMark));
			this.push(null);
			callback();
			return;
		}
        this._currentLength += chunk.length;
        if(this._currentLength === this.totalLength){
			this.push(chunk);
			this.finished = true;
            this._resolve();
			this.push(null);
			callback();
			return;
        }
		if (this.push(chunk)){
			callback();
		}else{
			this.callback = callback();
		}
	}
	_final(callback){
		if (this.finished){
			callback();
			return;
		}
		if (this._currentLength < this.totalLength){
			this.push(Buffer.alloc(this.totalLength - this._currentLength)); // Buffer.alloc automatically fills with NUL
		}
        this.finished = true;
        this._resolve(null);
        this.push(null);
    }
    _destroy(err, callback){
        this._reject(err);
        callback(err);
    }
}
class BlackHole extends Writable{
	constructor(options) {
		super(options);
	}
	_write(chunk, encoding, callback) {
		callback();
	}
	_writev(chunks, callback) {
		callback();
	}
	_destroy(err, callback) {
		callback(err);
	}
	_final(callback) {
		callback();
	}
}
class Transcoder extends EventEmitter{
	constructor(readable,writeable) {
        super();
        this.shitToRead = [];
		this.shitToSend = [];
		this.readable = readable;
		this.writeable = writeable;
		
		this.passStreamLen = 0;
		this.passStreamTotalLen = 0;
		
		let that = this;
		this.readable.on("error",function(err){
			that.bail(new SCONCommError("Input stream killed itself: "+err.name+": "+err.message));
		});
		this.readable.on("data",function(chunk){
			if (that.dead){
				return;
			}
            that.handleData(chunk);
		});
		this.readable.on("end",function(){
			try{
				that.stopSCON();
			}catch(ex){
				// Some writeables can't "end", process.stdout for example.
			}
			
		});
		this.writeable.on("error",function(err){
			that.bail(new SCONCommError("Output stream killed itself: "+err.name+": "+err.message));
		});
		this.writeable.on("finish",function(err){
			that.bail(new SCONCommError("Stream died a peaceful death"), true);
		});
    }
    handleData(chunk){
        this.shitToRead.unshift(chunk);
        if(this.sconNeedsDataResolve !== undefined){
            this.sconNeedsDataResolve(this.shitToRead.pop());
            delete this.sconNeedsDataResolve;
            delete this.sconNeedsDataReject
        }
        if(this.readingShit){
            return;
        }
        this.readingShit = true;
        (async () => {
            do{
                chunk = this.shitToRead.pop();
                if (this.passStream === undefined){
                    try{
                        let decodedData = await scon.decodeAsync(chunk, false, (requestedLength) => {
                            if (this.shitToRead.length === 0){
                                return new Promise((resolve, reject)=>{
                                    this.sconNeedsDataResolve = resolve;
                                    this.sconNeedsDataReject = reject;
                                });
                            }else{
                                return this.shitToRead.pop();
                            }
						});
                        if (decodedData.result.__data > 0){
                            this.passStream = new FixedLengthStream(decodedData.result.__data);
						}
						delete decodedData.result.__data;
                        this.OnSCON(decodedData.result,this.passStream);
                        if (decodedData.leftover.length > 0){
                            this.shitToRead.push(decodedData.leftover);
                        }
                    }catch(ex){
                        this.bail(ex);
                    }
                }else{
					await new Promise((resolve, reject) => {
						this.passStream.write(chunk, resolve);
					})
                    if (this.passStream.finished){
                        let leftOver = await this.passStream.leftover;
                        if (leftOver !== undefined){
                            this.shitToRead.push(leftOver);
                        }
                        delete this.passStream;
                    }
                }
			}while(this.shitToRead.length > 0);
			this.readingShit = false;
        })();
    }
	bail(err, peaceful){
		if (this.dead){
			return; // Already bailed
		}
		this.dead = true;
		
		while(this.shitToSend.length > 0){
			let thing = this.shitToSend.pop();
			if (!thing.__dead){
				thing.__reject(err);
			}
        }
        if (!peaceful){
			this.emit("error", err);
		}
		this.emit("disconnected");
	}
	stopSCON(){
		if (this.stopped){
			return;
		}
		this.stopped = true;
		if (this.sendingShit){
			this.wannaDie = true;
		}else{
			this.writeable.end();
		}
	}
	sendSCON(obj,sconOptions = false,stream,streamLength){
		if (this.dead){
			return Promise.reject(new SCONCommError("Thing's dead."));
		}
		let that = this;
		if ( obj.__data !== undefined || obj.__resolve !== undefined || obj.__reject !== undefined || obj._stream !== undefined){
			return Promise.reject(new TypeError("SCONComm.Transcoder: obj.__data, obj.__deadfunc, obj._stream, obj.__resolve, obj.__reject should be undefined"));
		}
		return new Promise(function(resolve,reject){
			if (streamLength != null && stream != null){
				obj.__data = streamLength | 0;
				stream.pause();
			}
			obj.__resolve = resolve;
			obj.__reject = reject;
			
			
			// If the stream kills itself before it's piped, throw an error that the caller can catch.
			obj.__deadfunc = function(err){
				obj.__reject(err);
				obj.__dead = true;
			}
			if (stream != null){
				obj._stream = stream;
				stream.on("error",obj.__deadfunc);
			}
			that.shitToSend.unshift(obj);
			if (!that.sendingShit){
				that.sendingShit = true;
				(async function(){
					let reject;
					try{
						do{
							let obj = that.shitToSend.pop();
							if (obj != null){
								let resolve = obj.__resolve;
								reject = obj.__reject;
								let stream = obj._stream;
								if (stream != null){
									stream.removeListener("error", obj.__deadfunc);
								}
								delete obj.__resolve;
								delete obj.__reject;
								delete obj._stream;
								delete obj.__deadfunc;
                                delete obj.__dead;
                                if (sconOptions instanceof Object){
                                    sconOptions.useMagicNumber = false;
                                }
								await writeAndWait(that.writeable,scon.encode(obj,sconOptions));
								if (stream == null){
									resolve();
								}else{
									let padder = new FixedLengthStream(obj.__data);
									
									stream.pipe(padder);
									stream.resume();
									// Have the padder do the "fill with NULs routine as SCON already said the width of the data."
									stream.on("error",function(err){
										stream.unpipe();
										padder.end();
									});
									padder.pipe(that.writeable,{ end: false });
									padder.on("end",resolve);
								}
								reject = null;
							}
						}while(that.shitToSend.length > 0);
						if (that.wannaDie){
							that.writeable.end();
						}
						that.sendingShit = false;
					}catch(ex){
						if (reject != null){
							reject(ex);
						}
						that.bail(ex);
					}
				})();
			}
		});
	}
}

class Client extends Transcoder {
	constructor(readable,writeable) {
		super(readable,writeable);
		this.resolves = [];
		this.rejects = [];
		this.type = "Client";
	}
	OnSCON(msg,stream) {
		if (stream !== undefined){
			msg._stream = stream;
		}
		if (msg.__id == null){
			this.emit("message",msg);
		}else{
			let i = msg.__id;
			delete msg.__id;
			this.resolves[i](msg);
			delete this.resolves[i];
			delete this.rejects[i];
		}
	}
	send(obj,sconOptions,stream,streamLength) {
		if (sconOptions instanceof Object && sconOptions.copy){
			obj = shallowCopy(obj);
		}
		let that = this;
		if (obj.__id !== undefined){
			return Promise.reject(new TypeError("SCONComm.Client: obj.__id should be undefined"));
		}else{
			return new Promise(function(resolve,reject){
				let i=0;
				while (that.resolves[i] !== undefined){
					i+=1;
				}
				that.resolves[i] = resolve;
				that.rejects[i] = reject;
				obj.__id = i;
				that.sendSCON(obj,sconOptions,stream,streamLength).catch(function(err){
					delete that.resolves[i];
					delete that.rejects[i];
					reject(err);
				});
			});
		}
	}
	disconnect() {
		return new Promise((resolve) => {
			this.once("disconnected",resolve);
			this.stopSCON();
		})
	}
}


class Server extends Transcoder {
	constructor(readable,writeable) {
		super(readable,writeable);
		this.type = "Server";
	}
	OnSCON(msg,stream) {
		let that = this;
		let i = msg.__id;
		delete msg.__id;
		if (i == null){
			if (stream !== undefined){
				stream.pipe(new BlackHole());
			}
			return; //If the stream was sent by a client, it will always jave an id.
		}
		if (stream !== undefined){
			msg._stream = stream;
		}
		this.emit("message",msg,function(object,sconOptions,stream,streamLength){
			if (sconOptions instanceof Object && sconOptions.copy){
				object = shallowCopy(object);
			}
			object.__id = i;
			return that.sendSCON(object,sconOptions,stream,streamLength);
		});
	}
	send(object,sconOptions,stream,streamLength) {
		if (sconOptions instanceof Object && sconOptions.copy){
			object = shallowCopy(object);
		}
		return this.sendSCON(object,sconOptions,stream,streamLength);
	}
	disconnect() {
		return new Promise((resolve) => {
			this.once("disconnected",resolve);
			this.stopSCON();
		})
	}
}

module.exports = {
	Client,
	Server,
	Transcoder,
	SCONCommError,
	BlackHole
};

