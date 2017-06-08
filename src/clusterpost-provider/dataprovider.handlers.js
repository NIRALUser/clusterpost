var request = require('request');
var _ = require('underscore');
var Promise = require('bluebird');
var Boom = require('boom');
var spawn = require('child_process').spawn;
var couchUpdateViews = require('couch-update-views');
var path = require('path');

module.exports = function (server, conf) {
	

	if(!server.methods.clusterprovider){
		throw new Error("Have you installed the 'couch-provider' plugin with namespace 'clusterprovider'?");
	}

	couchUpdateViews.migrateUp(server.methods.clusterprovider.getCouchDBServer(), path.join(__dirname, 'views'), true);

	var handler = {};
	/*
	*/
	handler.createJob = function(req, rep){
		
		var job = req.payload;
		job.timestamp = new Date();
		job.jobstatus = {
			status: 'CREATE'
		};		

		server.methods.clusterprovider.uploadDocuments(job)
		.then(function(res){
			if(res.length === 1){
				return res[0];
			}else{
				return res;
			}
		})
		.then(rep)
		.catch(function(e){
			rep(Boom.badRequest(e));
		});
		
	}

	/*
	*/
	handler.updateJob = function(req, rep){

		var job = req.payload;
		var credentials = req.auth.credentials;

		var prom = [
			server.methods.clusterprovider.validateJobOwnership(job, credentials),
			server.methods.clusterprovider.getDocument(job._id)
			.then(function(doc){
				return server.methods.clusterprovider.validateJobOwnership(doc, credentials);
			})
			.catch(function(e){
				throw Boom.unauthorized("You are not allowed to update the document, it belongs to someone else");
			})
		]

		
		Promise.all(prom)
		.then(function(){
			return server.methods.clusterprovider.uploadDocuments(job);
		})
		.then(rep)
		.catch(function(e){
			rep(Boom.wrap(e));
		});
	}

	/*
	*/
	handler.addData = function(req, rep){
		server.methods.clusterprovider.getDocument(req.params.id)
		.then(function(doc){
			return server.methods.clusterprovider.isJobDocument(doc);
		})
		.then(function(doc){
			return server.methods.clusterprovider.validateJobOwnership(doc, req.auth.credentials);
		})
		.then(function(doc){
			return server.methods.clusterprovider.addDocumentAttachment(doc, req.params.name, req.payload);
		})
		.then(rep)
		.catch(function(e){
			rep(Boom.wrap(e));
		});
	}

	const getDocumentURIAttachment = function(doc, name){
		if(doc._attachments && doc._attachments[name]){
			return server.methods.clusterprovider.getDocumentURIAttachment(doc._id + "/" + name);
		}else{
			var att = _.find(doc.inputs, function(input){
				return input.name === name;
			});
			if(!att){
				att = _.find(doc.outputs, function(output){
					return output.name === name;
				});
			}
			if(!att){
				throw Boom.notFound("The attachment was not found -> " + name);
			}					
			if(att.type === 'tar.gz'){
				name += ".tar.gz";
			}
			if(att.remote){
				if(att.remote.serverCodename){
					return server.methods.clusterprovider.getDocumentURIAttachment(att.remote.uri, att.remote.serverCodename);
				}else{ //The next case is for the dataprovider-fs
					return {
						uri: att.remote.uri,
						passThrough: true,
						rejectUnauthorized: false
					};
				}
			}else if(att.local){
				return server.methods.clusterprovider.getDocumentURIAttachment(att.local.uri);
			}else{
				return server.methods.clusterprovider.getDocumentURIAttachment(doc._id + "/" + name);
			}
			
		}
	}

	/*
	*/
	handler.getJob = function(req, rep){
		
		server.methods.clusterprovider.getDocument(req.params.id)
		.then(function(doc){
			return server.methods.clusterprovider.validateJobOwnership(doc, req.auth.credentials);
		})
		.then(function(doc){
			if(req.params.name){
				rep.proxy(getDocumentURIAttachment(doc, req.params.name));
			}else{
				rep(doc);
			}
			
		})
		.catch(function(e){
			rep(Boom.wrap(e));
		});
		
	}

	handler.getDownloadToken = function(req, rep){

		server.methods.clusterprovider.getDocument(req.params.id)
		.then(function(doc){			
			return server.methods.clusterprovider.validateJobOwnership(doc, req.auth.credentials);
		})
		.then(function(doc){

			var name = req.params.name;
			rep(server.methods.jwtauth.sign({ _id: doc._id, name: name }));
			
		})
		.catch(function(e){
			rep(Boom.wrap(e));
		});
	}

	handler.downloadAttachment = function(req, rep){
		var token = req.params.token;
		
		try{
			
			var decodedToken = server.methods.jwt.verify(token);
			
			server.methods.clusterprovider.getDocument(decodedToken._id)
			.then(function(doc){
				rep.proxy(getDocumentURIAttachment(doc, decodedToken.name));
			})
			.catch(function(e){
				rep(Boom.unauthorized(e));
			});
			
		}catch(e){
			rep(Boom.unauthorized(e));
		}
		
	}

	handler.deleteJob = function(req, rep){

		server.methods.clusterprovider.getDocument(req.params.id)
		.then(function(doc){
			return server.methods.clusterprovider.isJobDocument(doc);
		})
		.then(function(doc){
			return server.methods.clusterprovider.validateJobOwnership(doc, req.auth.credentials);
		})
		.then(function(doc){
			doc.jobstatus.status = "DELETE";
			return server.methods.clusterprovider.uploadDocuments(doc)
			.then(function(uploadstatus){			
				
				doc._rev = uploadstatus[0].rev;
				
				return server.methods.cronprovider.addJobToDeleteQueue(doc);			
			})
			.then(function(){
				return doc.jobstatus
			});;
		})
		.then(rep)
		.catch(function(e){
			rep(Boom.wrap(e));
		});
	}

	/*
	*/
	handler.getUserJobs = function(req, rep){

		var credentials = req.auth.credentials;
		var email = credentials.email;

		if(req.query.userEmail && email !== req.query.userEmail && credentials.scope.indexOf('admin') === -1){
			throw Boom.unauthorized("You are not allowed to view the jobs of other users.");
		}else if(req.query.userEmail){
			email = req.query.userEmail;
		}
		
		var jobstatus = req.query.jobstatus;
		var executable = req.query.executable;
		var executionserver = req.query.executionserver;
		var view;

		if(jobstatus && executable){
			var key = [email, jobstatus, executable];
			view = '_design/searchJob/_view/useremailjobstatusexecutable?include_docs=true&key=' + JSON.stringify(key);
		}else if(jobstatus){
			var key = [email, jobstatus];
			view = '_design/searchJob/_view/useremailjobstatus?include_docs=true&key=' + JSON.stringify(key);
		}else if(executable){
			var key = [email, executable];
			view = '_design/searchJob/_view/useremailexecutable?include_docs=true&key=' + JSON.stringify(key);
		}else if(executionserver){
			var key = {
				key: JSON.stringify([executionserver, jobstatus]),
				include_docs: true
			}
		    view = '_design/searchJob/_view/executionserverjobstatus?' + qs.stringify(key);
		}else{
			view = '_design/searchJob/_view/useremail?include_docs=true&key=' + JSON.stringify(email);
		}

		server.methods.clusterprovider.getView(view)
		.then(function(rows){
			return _.pluck(rows, 'doc');
		})
		.then(rep)
		.catch(function(e){
			rep(Boom.wrap(e));
		})
	}

	/*
	*/

	handler.getAllJobs = function(req, rep){
		var executable = req.query.executable;

		if(executable){
			var key = executable;
			view = '_design/searchJob/_view/executable?include_docs=true&key=' + JSON.stringify(key);
		}else{
			view = '_design/searchJob/_view/executable?include_docs=true';
		}
		server.methods.clusterprovider.getView(view)
		.then(function(rows){
			return _.pluck(rows, 'doc');
		})
		.then(rep)
		.catch(function(e){
			rep(Boom.wrap(e));
		});
	}

	return handler;
}
