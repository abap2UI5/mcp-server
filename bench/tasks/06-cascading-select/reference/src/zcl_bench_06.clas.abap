CLASS zcl_bench_06 DEFINITION PUBLIC.

  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    TYPES:
      BEGIN OF ty_s_option,
        key  TYPE string,
        text TYPE string,
      END OF ty_s_option.
    TYPES ty_t_option TYPE STANDARD TABLE OF ty_s_option WITH EMPTY KEY.
    DATA country   TYPE string.
    DATA city      TYPE string.
    DATA countries TYPE ty_t_option.
    DATA cities    TYPE ty_t_option.

  PROTECTED SECTION.
    TYPES:
      BEGIN OF ty_s_city,
        country TYPE string,
        city    TYPE string,
      END OF ty_s_city.
    DATA all_cities TYPE STANDARD TABLE OF ty_s_city WITH EMPTY KEY.
    DATA client     TYPE REF TO z2ui5_if_client.
    METHODS view_display.
    METHODS on_event.
    METHODS model_init.
    METHODS cities_fill.

  PRIVATE SECTION.
ENDCLASS.


CLASS zcl_bench_06 IMPLEMENTATION.

  METHOD z2ui5_if_app~main.

    me->client = client.
    IF client->check_on_init( ).
      model_init( ).
      view_display( ).
    ELSEIF client->check_on_navigated( ).
      view_display( ).
    ELSEIF client->check_on_event( ).
      on_event( ).
    ENDIF.

  ENDMETHOD.

  METHOD view_display.

    DATA(view) = z2ui5_cl_ui5_view_builder=>factory(
        )->ele( n = `View` ns = `mvc`
            )->a( n = `xmlns`        v = `sap.m`
            )->a( n = `xmlns:mvc`    v = `sap.ui.core.mvc`
            )->a( n = `xmlns:core`   v = `sap.ui.core`
            )->a( n = `displayBlock` v = `true`
            )->a( n = `height`       v = `100%` ).

    DATA(box) = view->ele( `Shell`
        )->ele( `Page`
            )->a( n = `title` v = `Shipping destination`
            )->ele( `VBox`
                )->a( n = `class` v = `sapUiSmallMargin` ).

    box->tag( `Label`
        )->a( n = `text` v = `Country` ).

    box->ele( `Select`
        )->a( n = `selectedKey` v = client->_bind( country )
        )->a( n = `forceSelection` v = `false`
        )->a( n = `items`       v = client->_bind( countries )
        )->a( n = `change`      v = client->_event( `COUNTRY_CHANGED` )
        )->ele( `items`
            )->tag( n = `Item` ns = `core`
                )->a( n = `key`  v = `{KEY}`
                )->a( n = `text` v = `{TEXT}` ).

    box->tag( `Label`
        )->a( n = `text` v = `City` ).

    box->ele( `Select`
        )->a( n = `selectedKey`    v = client->_bind( city )
        )->a( n = `forceSelection` v = `false`
        )->a( n = `items`          v = client->_bind( cities )
        )->ele( `items`
            )->tag( n = `Item` ns = `core`
                )->a( n = `key`  v = `{KEY}`
                )->a( n = `text` v = `{TEXT}` ).

    box->tag( `Button`
        )->a( n = `text`  v = `Confirm`
        )->a( n = `type`  v = `Emphasized`
        )->a( n = `press` v = client->_event( `CONFIRM` ) ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.

  METHOD on_event.

    CASE client->get_event( ).
      WHEN `COUNTRY_CHANGED`.
        city = ``.
        cities_fill( ).
      WHEN `CONFIRM`.
        IF city IS INITIAL.
          client->message_toast_display( `Choose a city first` ).
        ELSE.
          client->message_toast_display( |Shipping to { city }, { country }| ).
        ENDIF.
    ENDCASE.

  ENDMETHOD.

  METHOD cities_fill.

    cities = VALUE #( FOR c IN all_cities WHERE ( country = country ) ( key = c-city text = c-city ) ).

  ENDMETHOD.

  METHOD model_init.

    countries = VALUE #( ( key = `Germany` text = `Germany` )
                         ( key = `France`  text = `France` )
                         ( key = `Italy`   text = `Italy` ) ).

    all_cities = VALUE #( ( country = `Germany` city = `Berlin` )
                          ( country = `Germany` city = `Hamburg` )
                          ( country = `Germany` city = `Munich` )
                          ( country = `France`  city = `Paris` )
                          ( country = `France`  city = `Lyon` )
                          ( country = `France`  city = `Marseille` )
                          ( country = `Italy`   city = `Rome` )
                          ( country = `Italy`   city = `Milan` )
                          ( country = `Italy`   city = `Naples` ) ).

  ENDMETHOD.

ENDCLASS.
