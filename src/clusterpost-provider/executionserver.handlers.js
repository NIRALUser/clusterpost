var request = require('request');
var _ = require('underscore');
var Promise = require('bluebird');
var Boom = require('boom');
var spawn = require('child_process').spawn;
var fs = require('fs');
var os = require('os');
var path = require('path');

module.exports = function (server, conf) {
	

	var handler = {};
	var LinkedList = require('linkedlist');
	var remotedeletequeue = new LinkedList();

	const startExecutionServers = function(){
		return Promise.map(_.keys(conf.executionservers), function(eskey){
			return new Promise(function(resolve, reject){
				var token = server.methods.jwtauth.sign({ executionserver: eskey }, { 
                                "algorithm": "HS256",
                                "expiresIn": "356d"
                });
				var filename = path.join(os.tmpdir(), "." + eskey);
				fs.writeFile(filename, JSON.stringify(token), function(err){
					if(err){
						reject(err);
					}else{
						resolve(filename);
					}
				})
			})
			.then(function(filename){
				return new Promise(function(resolve, reject){
					var executionserver = conf.executionservers[eskey];
					if(!executionserver.remote){
						var destination = path.join(executionserver.sourcedir, ".token");
					
						const scp = spawn('scp', ['-i', executionserver.identityfile, filename, executionserver.user + "@" + executionserver.hostname + ":" + destination ]);
						var alldata = "";
						scp.stdout.on('data', function(data){
							alldata += data;
						});

						var allerror = "";
						scp.stderr.on('data', function(data){
							allerror += data;
						});

						scp.on('close', function(code){
							if(code != 0 && allerror !== ''){
								reject(Boom.badImplementation(allerror));
							}else{
								resolve(filename);
							}
						});
					}
				});
			})
			.then(function(filename){
				try{
					var stats = fs.statSync(filename);
					if(stats){
						fs.unlink(filename);
					}
				}catch(e){
					console.error(e);
				}
				
			})
			.catch(function(err){
				console.error(err);
			});
		});
	}

	server.method({
		name: "executionserver.startExecutionServers",
		method: startExecutionServers,
		options: {}
	});

	handler.getExecutionServers = function(req, rep){
		var executionservers = [];
		_.each(conf.executionservers, function(es, key){
			var obj = {
				name: key
			};
			if(es.queues){
				obj.queues = es.queues;
			}
			executionservers.push(obj);
		});
		rep(executionservers);
	}

	const getExecutionServer = function(key){
		return conf.executionservers[key];
	}

	server.method({
		name: 'executionserver.getExecutionServer',
		method: getExecutionServer,
		options: {}
	});


	const submitJob = function(doc){
		var executionserver = conf.executionservers[doc.executionserver];
		if(!executionserver){
			return Promise.reject("No execution server configured", doc.executionserver);			
		}
		if(executionserver.remote){
			return Promise.resolve(true);
		}
		return new Promise(function(resolve, reject){

			try{
				var params = ['-q', '-i', executionserver.identityfile, executionserver.user + "@" + executionserver.hostname, "node", executionserver.sourcedir + "/index.js", "-j", doc._id, "--submit"];

				if(doc.force){
					params.push("-f");
				}

				const submitjob = spawn('ssh', params);

				var alldata = "";
				submitjob.stdout.on('data', function(data){
					alldata += data;
				});

				var allerror = "";
				submitjob.stderr.on('data', function(data){
					allerror += data;
				});

				submitjob.on('close', function(code){
					if(code !== 0 || allerror !== ''){
						console.error(allerror);
						console.log(alldata);
						reject(Boom.badImplementation(allerror));
					}else{
						var view = "_design/getJob/_view/status?key=" + JSON.stringify(doc._id);
					    server.methods.clusterprovider.getView(view)
					    .then(function(docs){				    	
					    	resolve(_.pluck(docs, "value")[0]);
					    })
					    .catch(function(e){
					    	reject(Boom.badImplementation(e));
					    });
					}
				});
			}catch(e){
				reject(e);
			}
			
		});
	}

	server.method({
		name: 'executionserver.submitJob',
		method: submitJob,
		options: {}
	});

	/*
	*/
	handler.submitJob = function(req, rep){

		server.methods.clusterprovider.getDocument(req.params.id)
		.then(function(doc){
			return server.methods.clusterprovider.validateJobOwnership(doc, req.auth.credentials);
		})
		.then(function(doc){
			doc.jobstatus.status = "QUEUE";
			return server.methods.clusterprovider.uploadDocuments(doc)
			.then(function(uploadstatus){
				return server.methods.cronprovider.addJobToSubmitQueue(doc, req.payload.force);
			})
			.then(function(){
				return doc.jobstatus
			});
		})
		.then(function(res){
			rep(res);
		}).catch(function(e){
			rep(Boom.badImplementation(e));
		});
	}


	const jobStatus = function(doc){
		var executionserver = conf.executionservers[doc.executionserver];
		if(!executionserver){
			return Promise.reject("No execution server configured", doc.executionserver);			
		}
		if(executionserver.remote){
			return Promise.resolve(true);
		}
		return new Promise(function(resolve, reject){			
			try{
				const jobstatus = spawn('ssh', ['-q', '-i', executionserver.identityfile, executionserver.user + "@" + executionserver.hostname, "node", executionserver.sourcedir + "/index.js", "-j", doc._id, "--status"]);
				
				var alldata = "";
				jobstatus.stdout.on('data', function(data){
					alldata += data;
				});

				var allerror = "";
				jobstatus.stderr.on('data', function(data){
					allerror += data;
				});

				jobstatus.on('close', function(code){
					if(allerror !== ""){
						alldata += allerror;
					}
					var view = "_design/getJob/_view/status?key=" + JSON.stringify(doc._id);
				    server.methods.clusterprovider.getView(view)
				    .then(function(docs){				    	
				    	resolve(_.pluck(docs, "value")[0]);
				    })
				    .catch(reject);
				});
				
			}catch(e){
				reject(e);
			}
			
		});
	}

	server.method({
	    name: 'executionserver.jobStatus',
	    method: jobStatus,
	    options: {}
	});

	handler.jobStatus = function(req, rep){

		server.methods.clusterprovider.getDocument(req.params.id)
		.then(function(doc){
			return server.methods.clusterprovider.validateJobOwnership(doc, req.auth.credentials);
		})
		.then(function(doc){
			if(doc.jobstatus.status === 'RUN' || doc.jobstatus.status === 'UPLOADING'){
				return server.methods.cronprovider.addJobToUpdateQueue(doc)
				.then(function(){
					return doc.jobstatus;
				});
			}
			return doc.jobstatus;
		})
		.then(rep)
		.catch(function(e){
			rep(Boom.wrap(e));
		});
		
	}

	const jobKill = function(doc){
		var executionserver = conf.executionservers[doc.executionserver];
		
		if(!executionserver){
			return Promise.reject("No execution server configured", doc.executionserver);			
		}
		if(executionserver.remote){
			return Promise.resolve(true);
		}		
		return new Promise(function(resolve, reject){						
			try{					
				const jobstatus = spawn('ssh', ['-q', '-i', executionserver.identityfile, executionserver.user + "@" + executionserver.hostname, "node", executionserver.sourcedir + "/index.js", "-j", doc._id, "--kill"]);
				
				var alldata = "";
				jobstatus.stdout.on('data', function(data){
					alldata += data;
				});

				var allerror = "";
				jobstatus.stderr.on('data', function(data){
					allerror += data;
				});
				
				jobstatus.on('close', function(code){
					if(allerror !== ""){
						alldata += allerror;
					}
					var view = "_design/getJob/_view/status?key=" + JSON.stringify(doc._id);
				    server.methods.clusterprovider.getView(view)
				    .then(function(docs){				    	
				    	resolve(_.pluck(docs, "value")[0]);
				    })
				    .catch(reject);
				});
				
			}catch(e){
				reject(e);
			}
			
		});
	}

	server.method({
	    name: 'executionserver.jobKill',
	    method: jobKill,
	    options: {}
	});
	

	handler.killJob = function(req, rep){
		server.methods.clusterprovider.getDocument(req.params.id)
		.then(function(doc){
			return server.methods.clusterprovider.validateJobOwnership(doc, req.auth.credentials);
		})
		.then(function(doc){
			doc.jobstatus.status = "KILL";
			return server.methods.clusterprovider.uploadDocuments(doc)
			.then(function(uploadstatus){
				return server.methods.cronprovider.addJobToKillQueue(doc);
			})
			.then(function(){
				return doc.jobstatus
			});
		})
		.then(function(res){
			rep(res);
		})
		.catch(function(e){
			rep(Boom.badImplementation(e));
		});
	}

	const jobDelete = function(doc){
		var executionserver = conf.executionservers[doc.executionserver];
		if(!executionserver){
			return Promise.reject("No execution server configured", doc.executionserver);			
		}
		if(executionserver.remote){
			remotedeletequeue.push(doc);
			return Promise.resolve(true);
		}
		return new Promise(function(resolve, reject){
			try{

				const jobdelete = spawn('ssh', ['-q', '-i', executionserver.identityfile, executionserver.user + "@" + executionserver.hostname, "node", executionserver.sourcedir + "/index.js", "-j", doc._id, "--delete"]);

				var alldata = "";
				jobdelete.stdout.on('data', function(data){
					alldata += data;
				});

				var allerror = "";
				jobdelete.stderr.on('data', function(data){
					allerror += data;
				});

				jobdelete.on('close', function(code){
					if(allerror !== ""){
						reject(Boom.badImplementation(allerror));
					}else{
						var view = "_design/getJob/_view/status?key=" + JSON.stringify(doc._id);
					    server.methods.clusterprovider.getView(view)
					    .then(function(docs){				    	
					    	resolve(_.pluck(docs, "value")[0]);
					    })
					    .catch(function(e){
					    	reject(Boom.badImplementation(e));
					    });
					}
				});
			}catch(e){
				console.error(e);
				reject(e);
			}
		});
	}

	server.method({
	    name: 'executionserver.jobDelete',
	    method: jobDelete,
	    options: {}
	});

	handler.getDeleteQueue = function(req, rep){		

		var remotedeletejobs = [];		
		while (remotedeletequeue.length) {
			remotedeletejobs.push(remotedeletequeue.shift());
		}		
		rep(remotedeletejobs);
	}

	handler.getExecutionServerTokens = function(req, rep){


		var tokens = _.map(conf.executionservers, function(es, eskey){
			if(es.remote){
				var token = server.methods.jwtauth.sign({ executionserver: eskey }, { 
                    "algorithm": "HS256",
                    "expiresIn": "356d"
                });

				token.executionserver = eskey;
                return token;
			}
			return null;
		});
		
		rep(_.compact(tokens));

	}

	return handler;

}
