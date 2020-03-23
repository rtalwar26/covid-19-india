module.exports = class {

  onCreate() {

  }

  onMount() {



  }


  login_success() {

    fetch("/static/csv-files/delhi/delhi.csv").then((response) => response.text()).then((data) => {
      console.log(data);

      csv({
        output: "csv"
      })
        .fromString(data)
        .then((result) => {
          let selected_pincode = window.app.data.pincode;

          console.log({ pincode: window.app.data.pincode });
          console.log({ result });

          let found = undefined;
          for (let i = 0; i < result.length && !found; i++) {
            found = selected_pincode == result[i][0] ? result[i] : found;
          }

          found ? this.populate_data(found) : this.not_found_error(selected_pincode);
        })
    })


  }
  not_found_error(pincode) {
    alert(`Data not found for pincode:${pincode}`);
  }
  populate_data(found) {
    window.app.data.record = found;
    window.app.views && window.app.views.main.router.navigate({
      name: "home-page"
    });
  }

}
