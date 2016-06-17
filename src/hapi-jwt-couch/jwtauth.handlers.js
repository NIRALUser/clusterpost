
module.exports = function (server, conf) {

	var jwt = require('jsonwebtoken');
	var bcrypt = require('bcrypt');
	const saltRounds = conf.saltRounds;
	var Boom = require('boom');
	var _ = require('underscore');
	var nodemailer = require('nodemailer');
	require('couch-provider')(conf.userdb, server, 'hapijwtcouch');

	var transporter;

	if(conf.mailer.nodemailer === 'nodemailer-stub-transport'){
		transporter = nodemailer.createTransport(require(conf.mailer.nodemailer)());
	}else{
		transporter = nodemailer.createTransport(conf.mailer.nodemailer);
	}

	transporter.verify(function(error, success) {
		if (error) {
			console.log(error);
		}else{
			console.log(success);
		}
	});

	server.methods.hapijwtcouch.getDocument("_design/user")
	.catch(function(err){
		var couchUpdateViews = require('couch-update-views');
		var path = require('path');
		couchUpdateViews.migrateUp(server.methods.hapijwtcouch.getCouchDBServer(), path.join(__dirname, 'views'));
	});



	var handler = {};

	const sign = function(user, maxAge){
		var token = {};
		var algo = conf.algorithm;
		if(maxAge){
			algo.maxAge = maxAge;
		}
		token.token = jwt.sign(user, conf.privateKey, algo );
		return token;
	}

	server.method({
		name: 'jwtauth.sign',
		method: sign,
		options: {}
	});

	handler.validateUser = function(req, decodedToken){
		
		return server.methods.hapijwtcouch.getView('_design/user/_view/info?key=' + JSON.stringify(decodedToken.email))
		.then(function(info){
			var info = _.pluck(info, "value");

			if(info.length > 1){
				throw Boom.unauthorized("More than 1 user with same email found in DB!");
			}else if(info.length === 0){
				throw Boom.unauthorized("User not found in db")
			}

			return info[0];
		});
	}

	const bcryptHash = function(password){
		return new Promise(function(resolve, reject){
			bcrypt.hash(password, conf.saltRounds, function(err, hash) {
				if(err){
					reject(err);
				}else{
					resolve(hash);
				}
			});
		});
	}

	handler.createUser = function(req, rep){

		var email = req.payload.email;
		var password = req.payload.password;

		server.methods.hapijwtcouch.getView('_design/user/_view/info?key=' + JSON.stringify(email))
		.then(function(info){

			var info = _.pluck(info, "value");

			if(info.length === 0){
				return bcryptHash(password);
			}else{
				throw Boom.conflict("User already exists");
			}
		})
		.then(function(hash){

			var user = req.payload;
			user.password = hash;
			user.type = 'user';
			user.scope = ['clusterpost'];

			return server.methods.hapijwtcouch.uploadDocuments(user)
			.then(function(res){
				res = res[0];
				if(res.ok){
					return server.methods.jwtauth.sign({ email: user.email });
				}else{
					throw Boom.badData(res);
				}
			});
			
		})
		.then(rep)
		.catch(rep);

	}

	handler.getUser = function(req, rep){
		var credentials = req.auth.credentials;
		rep({
			name: credentials.name,
			email: credentials.email, 
			scope: credentials.scope
		});
	}

	handler.login = function(req, rep){
		
		var email = req.payload.email;
		var password = req.payload.password;

		server.methods.hapijwtcouch.getView('_design/user/_view/hash?key=' + JSON.stringify(email))
		.then(function(hash){
			return _.pluck(hash, "value")[0];
		})
		.then(function(hash){
			return new Promise(function(resolve, reject){
				bcrypt.compare(password, hash, function(err, res) {
					if(res){
						resolve(server.methods.jwtauth.sign({ email: email }));
					}else{
						reject(err);
					}
				});
			});
		})
		.then(rep)
		.catch(function(err){
			rep(Boom.unauthorized(err));
		});
	}

	handler.loginUpdate = function(req, rep){

		var credentials = req.auth.credentials;
		var email = credentials.email;
		var password = req.payload.password;

		server.methods.hapijwtcouch.getDocument(credentials._id)
		.then(function(user){
			return bcryptHash(password)
			.then(function(hash){
				
				user.password = hash;

				return server.methods.hapijwtcouch.uploadDocuments(user)
				.then(function(res){
					res = res[0];
					if(res.ok){
						return server.methods.jwtauth.sign({ email: user.email });
					}else{
						throw Boom.badImplementation(res);
					}
				});
			})
		})
		.then(rep)
		.catch(function(err){
			rep(Boom.unauthorized(err));
		});
	}

	handler.deleteUser = function(req, rep){
		
		var credentials = req.auth.credentials;

		server.methods.hapijwtcouch.deleteDocument(credentials)
		.then(rep)
		.catch(function(err){
			rep(Boom.conflict(err));
		})
	}

	handler.resetPassword = function(req, rep){
		var email = req.payload.email;

		server.methods.hapijwtcouch.getView('_design/user/_view/info?key=' + JSON.stringify(email))
		.then(function(info){
			var info = _.pluck(info, "value");
			if(info.length === 0){
				throw Boom.unauthorized("I don't know who you are, you need to create an account first!");
			}

			info = info[0];

			var maxAge = (new Date().getTime() + 30 * 60 * 1000)/1000;
			
			var message = conf.mailer.message;

			message.replace('@USERNAME@', info.name);
			message.replace('@SERVER@', server.info.uri);
			message.replace('@TOKEN@', token.token);

			var mailOptions = {
			    from: conf.mailer.from,
			    to: email,
			    subject: 'Password reset', // Subject line
			    html: message
			};
			
			transporter.sendMail(mailOptions, function(error, info){
			    if(error){
			        rep(Boom.badImplementation(error));
			    }else{
			    	rep("An email has been sent to recover your password.");
			    }
			});
		})
		.catch(function(err){
			rep(Boom.wrap(err));
		});

		

		
	}



	return handler;
}