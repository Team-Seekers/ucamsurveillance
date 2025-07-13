
const { Schema, model } = require("mongoose");

const opencvSchema = new Schema({
    name: {
        type: String,
        required: true
    },
    email: {
        type: String,
        required: true
    },
    phonenumber: {
        type: String,
        required: true
    },
    password: {
        type: String,
        required: true
    },
    resettoken: {
        type: String,
        default:'',
    },
    resetexpiry: {
        type: Date,
        default: null,
    },
    otp:{
        type: String,
        default:'',
    }  
})


const User = model("User", opencvSchema);

module.exports = User