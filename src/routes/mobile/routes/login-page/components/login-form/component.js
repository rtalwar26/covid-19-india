

module.exports = class {

  signIn() {

    window.app.data.pincode = this.getEl('pincode').value;
    this.emit('login');
  }


}
